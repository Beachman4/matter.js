/**
 * @license
 * Copyright 2022-2024 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    Bytes,
    ChannelType,
    Diagnostic,
    DnsCodec,
    DnsMessagePartiallyPreEncoded,
    DnsMessageType,
    DnsQuery,
    DnsRecord,
    DnsRecordClass,
    DnsRecordType,
    ImplementationError,
    Lifespan,
    Logger,
    MAX_MDNS_MESSAGE_SIZE,
    Network,
    ServerAddress,
    ServerAddressIp,
    SrvRecordValue,
    Time,
    Timer,
    UdpMulticastServer,
    createPromise,
    isIPv6,
} from "#general";
import { NodeId, VendorId } from "#types";
import {
    CommissionableDevice,
    CommissionableDeviceIdentifiers,
    DiscoveryData,
    OperationalDevice,
    Scanner,
} from "../common/Scanner.js";
import { Fabric } from "../fabric/Fabric.js";
import {
    MATTER_COMMISSION_SERVICE_QNAME,
    MATTER_SERVICE_QNAME,
    getCommissioningModeQname,
    getDeviceInstanceQname,
    getDeviceMatterQname,
    getDeviceTypeQname,
    getLongDiscriminatorQname,
    getShortDiscriminatorQname,
    getVendorQname,
} from "./MdnsConsts.js";
import { MDNS_BROADCAST_IPV4, MDNS_BROADCAST_IPV6, MDNS_BROADCAST_PORT } from "./MdnsServer.js";

const logger = Logger.get("MdnsScanner");

type MatterServerRecordWithExpire = ServerAddressIp & Lifespan;

type CommissionableDeviceRecordWithExpire = Omit<CommissionableDevice, "addresses"> &
    Lifespan & {
        addresses: Map<string, MatterServerRecordWithExpire>; // Override addresses type to include expiration
        instanceId: string; // instance ID
        SD: number; // Additional Field for Short discriminator
        V?: number; // Additional Field for Vendor ID
        P?: number; // Additional Field for Product ID
    };

type OperationalDeviceRecordWithExpire = Omit<OperationalDevice, "addresses"> &
    Lifespan & {
        addresses: Map<string, MatterServerRecordWithExpire>; // Override addresses type to include expiration
    };

/** The initial number of seconds between two announcements. MDNS specs require 1-2 seconds, so lets use the middle. */
const START_ANNOUNCE_INTERVAL_SECONDS = 1.5;

/**
 * This class implements the Scanner interface for a MDNS scanner via UDP messages in a IP based network.
 * It sends out queries to discover various types of Matter device types and listens for announcements.
 */
export class MdnsScanner implements Scanner {
    get type() {
        return ChannelType.UDP;
    }

    static async create(network: Network, options?: { enableIpv4?: boolean; netInterface?: string }) {
        const { enableIpv4, netInterface } = options ?? {};
        return new MdnsScanner(
            await UdpMulticastServer.create({
                network,
                netInterface: netInterface,
                broadcastAddressIpv4: enableIpv4 ? MDNS_BROADCAST_IPV4 : undefined,
                broadcastAddressIpv6: MDNS_BROADCAST_IPV6,
                listeningPort: MDNS_BROADCAST_PORT,
            }),
            enableIpv4,
        );
    }

    readonly #activeAnnounceQueries = new Map<string, { queries: DnsQuery[]; answers: DnsRecord<any>[] }>();
    #queryTimer?: Timer;
    #nextAnnounceIntervalSeconds = START_ANNOUNCE_INTERVAL_SECONDS;

    readonly #operationalDeviceRecords = new Map<string, OperationalDeviceRecordWithExpire>();
    readonly #commissionableDeviceRecords = new Map<string, CommissionableDeviceRecordWithExpire>();
    readonly #recordWaiters = new Map<
        string,
        {
            resolver: () => void;
            timer?: Timer;
            resolveOnUpdatedRecords: boolean;
        }
    >();
    readonly #periodicTimer: Timer;
    #closing = false;

    readonly #multicastServer: UdpMulticastServer;
    readonly #enableIpv4?: boolean;

    constructor(multicastServer: UdpMulticastServer, enableIpv4?: boolean) {
        multicastServer.onMessage((message, remoteIp, netInterface) =>
            this.#handleDnsMessage(message, remoteIp, netInterface),
        );
        this.#multicastServer = multicastServer;
        this.#enableIpv4 = enableIpv4;
        this.#periodicTimer = Time.getPeriodicTimer("Discovered node expiration", 60 * 1000 /* 1 mn */, () =>
            this.#expire(),
        ).start();
    }

    /**
     * Sends out one DNS-SD query for all collected announce records and start a timer for the next query with doubled
     * interval, maximum 60min, as per MDNS specs. The already known answers are tried to be sent in the query as long
     * as they fit into a maximum 1500 byte long packet (as defined in MDNS specs), else they are split into more
     * packets and the query is sent as Truncated query.
     */
    async #sendQueries() {
        this.#queryTimer?.stop();
        const allQueries = Array.from(this.#activeAnnounceQueries.values());
        const queries = allQueries.flatMap(({ queries }) => queries);
        const answers = allQueries.flatMap(({ answers }) => answers);

        this.#queryTimer = Time.getTimer("MDNS discovery", this.#nextAnnounceIntervalSeconds * 1000, () =>
            this.#sendQueries(),
        ).start();

        logger.debug(
            `Sending ${queries.length} query records for ${this.#activeAnnounceQueries.size} queries with ${answers.length} known answers. Re-Announce in ${this.#nextAnnounceIntervalSeconds} seconds`,
        );

        const nextAnnounceInterval = this.#nextAnnounceIntervalSeconds * 2;
        this.#nextAnnounceIntervalSeconds = Math.min(nextAnnounceInterval, 60 * 60 /* 1 hour */);

        const answersToSend = [...answers];

        const dnsMessageDataToSend = {
            messageType: DnsMessageType.TruncatedQuery,
            transactionId: 0,
            queries,
            authorities: [],
            answers: [],
            additionalRecords: [],
        } as DnsMessagePartiallyPreEncoded;

        const emptyDnsMessage = DnsCodec.encode(dnsMessageDataToSend);
        let dnsMessageSize = emptyDnsMessage.length;

        while (true) {
            if (answersToSend.length > 0) {
                const nextAnswer = answersToSend.shift();
                if (nextAnswer === undefined) {
                    break;
                }

                const nextAnswerEncoded = DnsCodec.encodeRecord(nextAnswer);
                dnsMessageSize += nextAnswerEncoded.length; // Add additional record as long as size is ok

                if (dnsMessageSize > MAX_MDNS_MESSAGE_SIZE) {
                    if (dnsMessageDataToSend.answers.length === 0) {
                        // The first answer is already too big, log at least a warning
                        logger.warn(
                            `MDNS Query with ${Logger.toJSON(
                                queries,
                            )} is too big to fit into a single MDNS message. Send anyway, but please report!`,
                        );
                    }
                    // New answer do not fit anymore, send out the message
                    await this.#multicastServer.send(DnsCodec.encode(dnsMessageDataToSend));

                    // Reset the message, length counter and included answers to count for next message
                    dnsMessageDataToSend.queries.length = 0;
                    dnsMessageDataToSend.answers.length = 0;
                    dnsMessageSize = emptyDnsMessage.length + nextAnswerEncoded.length;
                }
                dnsMessageDataToSend.answers.push(nextAnswerEncoded);
            } else {
                break;
            }
        }

        await this.#multicastServer.send(
            DnsCodec.encode({ ...dnsMessageDataToSend, messageType: DnsMessageType.Query }),
        );
    }

    /**
     * Set new DnsQuery records to the list of active queries to discover devices in the network and start sending them
     * out. When entry already exists the query is overwritten and answers are always added.
     */
    #setQueryRecords(queryId: string, queries: DnsQuery[], answers: DnsRecord<any>[] = []) {
        const activeExistingQuery = this.#activeAnnounceQueries.get(queryId);
        if (activeExistingQuery) {
            const { queries: existingQueries } = activeExistingQuery;
            const newQueries = queries.filter(
                query =>
                    !existingQueries.some(
                        existingQuery =>
                            existingQuery.name === query.name &&
                            existingQuery.recordType === query.recordType &&
                            existingQuery.recordClass === query.recordClass,
                    ),
            );
            if (newQueries.length === 0) {
                // All queries already sent out
                logger.debug(
                    `No new query records for query ${queryId}, keeping existing queries and do not re-announce.`,
                );
                return;
            }
            queries = [...newQueries, ...existingQueries];
            answers = [...activeExistingQuery.answers, ...answers];
        }
        this.#activeAnnounceQueries.set(queryId, { queries, answers });
        logger.debug(`Set ${queries.length} query records for query ${queryId}: ${Logger.toJSON(queries)}`);
        this.#queryTimer?.stop();
        this.#nextAnnounceIntervalSeconds = START_ANNOUNCE_INTERVAL_SECONDS; // Reset query interval
        this.#queryTimer = Time.getTimer("MDNS discovery", 0, () => this.#sendQueries()).start();
    }

    #getActiveQueryEarlierAnswers() {
        return Array.from(this.#activeAnnounceQueries.values()).flatMap(({ answers }) => answers);
    }

    /**
     * Remove a query from the list of active queries because discovery has finished or timed out and stop sending it
     * out. If it was the last query announcing will stop completely.
     */
    #removeQuery(queryId: string) {
        this.#activeAnnounceQueries.delete(queryId);
        if (this.#activeAnnounceQueries.size === 0) {
            logger.debug(`Removing last query ${queryId} and stopping announce timer`);
            this.#queryTimer?.stop();
            this.#nextAnnounceIntervalSeconds = START_ANNOUNCE_INTERVAL_SECONDS;
        } else {
            logger.debug(`Removing query ${queryId}`);
        }
    }

    /**
     * Returns the list of all targets (IP/port) discovered for a queried operational device record.
     */
    #getOperationalDeviceRecords(deviceMatterQname: string): OperationalDevice | undefined {
        const device = this.#operationalDeviceRecords.get(deviceMatterQname);
        if (device === undefined) {
            return undefined;
        }
        const { addresses } = device;
        if (addresses.size === 0) {
            return undefined;
        }
        return {
            ...device,
            addresses: this.#sortServerEntries(Array.from(addresses.values())).map(({ ip, port }) => ({
                ip,
                port,
                type: "udp",
            })) as ServerAddressIp[],
        };
    }

    /**
     * Sort the list of found IP/ports and make sure link-local IPv6 addresses come first, IPv6 next and IPv4 last.
     *
     * @param entries
     */
    #sortServerEntries(entries: MatterServerRecordWithExpire[]) {
        return entries.sort((a, b) => {
            const aIsIPv6 = isIPv6(a.ip);
            const bIsIPv6 = isIPv6(b.ip);

            if (aIsIPv6 && !bIsIPv6) {
                return -1; // IPv6 comes first
            } else if (!aIsIPv6 && bIsIPv6) {
                return 1; // IPv4 comes after IPv6
            } else if (aIsIPv6 && bIsIPv6) {
                if (a.ip.startsWith("fd") && !b.ip.startsWith("fd")) {
                    return -1; // addresses starting with "fd" come before other IPv6 addresses
                } else if (!a.ip.startsWith("fd") && b.ip.startsWith("fd")) {
                    return 1; // addresses starting with "fd" come after other IPv6 addresses
                } else if (a.ip.startsWith("fe80:") && !b.ip.startsWith("fe80:")) {
                    return -1; // link-local IPv6 comes before other global IPv6 addresses
                } else if (!a.ip.startsWith("fe80:") && b.ip.startsWith("fe80:")) {
                    return 1; // link-local IPv6 comes after other global IPv6 addresses
                }
            }
            return 0; // no preference
        });
    }

    /**
     * Registers a deferred promise for a specific queryId together with a timeout and return the promise.
     * The promise will be resolved when the timer runs out latest.
     */
    async #registerWaiterPromise(queryId: string, timeoutSeconds?: number, resolveOnUpdatedRecords = true) {
        const { promise, resolver } = createPromise<void>();
        const timer =
            timeoutSeconds !== undefined
                ? Time.getTimer("MDNS timeout", timeoutSeconds * 1000, () => this.#finishWaiter(queryId, true)).start()
                : undefined;
        this.#recordWaiters.set(queryId, { resolver, timer, resolveOnUpdatedRecords });
        logger.debug(
            `Registered waiter for query ${queryId} with ${
                timeoutSeconds !== undefined ? `timeout ${timeoutSeconds} seconds` : "no timeout"
            }${resolveOnUpdatedRecords ? "" : " (not resolving on updated records)"}`,
        );
        await promise;
    }

    /**
     * Remove a waiter promise for a specific queryId and stop the connected timer. If required also resolve the
     * promise.
     */
    #finishWaiter(queryId: string, resolvePromise: boolean, isUpdatedRecord = false) {
        const waiter = this.#recordWaiters.get(queryId);
        if (waiter === undefined) return;
        const { timer, resolver, resolveOnUpdatedRecords } = waiter;
        if (isUpdatedRecord && !resolveOnUpdatedRecords) return;
        logger.debug(`Finishing waiter for query ${queryId}, resolving: ${resolvePromise}`);
        if (timer !== undefined) {
            timer.stop();
        }
        if (resolvePromise) {
            resolver();
        }
        this.#recordWaiters.delete(queryId);
    }

    /** Returns weather a waiter promise is registered for a specific queryId. */
    #hasWaiter(queryId: string) {
        return this.#recordWaiters.has(queryId);
    }

    #createOperationalMatterQName(operationalId: Uint8Array, nodeId: NodeId) {
        const operationalIdString = Bytes.toHex(operationalId).toUpperCase();
        return getDeviceMatterQname(operationalIdString, NodeId.toHexString(nodeId));
    }

    /**
     * Method to find an operational device (already commissioned) and return a promise with the list of discovered
     * IP/ports or an empty array if not found.
     */
    async findOperationalDevice(
        { operationalId }: Fabric,
        nodeId: NodeId,
        timeoutSeconds?: number,
        ignoreExistingRecords = false,
    ): Promise<OperationalDevice | undefined> {
        if (this.#closing) {
            throw new ImplementationError("Cannot discover operational device because scanner is closing.");
        }
        const deviceMatterQname = this.#createOperationalMatterQName(operationalId, nodeId);

        let storedDevice = ignoreExistingRecords ? undefined : this.#getOperationalDeviceRecords(deviceMatterQname);
        if (storedDevice === undefined) {
            const promise = this.#registerWaiterPromise(deviceMatterQname, timeoutSeconds);

            this.#setQueryRecords(deviceMatterQname, [
                {
                    name: deviceMatterQname,
                    recordClass: DnsRecordClass.IN,
                    recordType: DnsRecordType.SRV,
                },
            ]);

            await promise;
            storedDevice = this.#getOperationalDeviceRecords(deviceMatterQname);
            this.#removeQuery(deviceMatterQname);
        }
        return storedDevice;
    }

    cancelOperationalDeviceDiscovery(fabric: Fabric, nodeId: NodeId, resolvePromise = true) {
        const deviceMatterQname = this.#createOperationalMatterQName(fabric.operationalId, nodeId);
        this.#finishWaiter(deviceMatterQname, resolvePromise);
    }

    cancelCommissionableDeviceDiscovery(identifier: CommissionableDeviceIdentifiers, resolvePromise = true) {
        const queryId = this.#buildCommissionableQueryIdentifier(identifier);
        this.#finishWaiter(queryId, resolvePromise);
    }

    getDiscoveredOperationalDevice({ operationalId }: Fabric, nodeId: NodeId) {
        return this.#getOperationalDeviceRecords(this.#createOperationalMatterQName(operationalId, nodeId));
    }

    /**
     * Returns the metadata and list of all target addresses (IP/port) discovered for a queried commissionable device
     * record.
     */
    #getCommissionableDeviceRecords(identifier: CommissionableDeviceIdentifiers) {
        const storedRecords = Array.from(this.#commissionableDeviceRecords.values());

        const foundRecords = new Array<CommissionableDeviceRecordWithExpire>();
        if ("instanceId" in identifier) {
            foundRecords.push(...storedRecords.filter(({ instanceId }) => instanceId === identifier.instanceId));
        } else if ("longDiscriminator" in identifier) {
            foundRecords.push(...storedRecords.filter(({ D }) => D === identifier.longDiscriminator));
        } else if ("shortDiscriminator" in identifier) {
            foundRecords.push(...storedRecords.filter(({ SD }) => SD === identifier.shortDiscriminator));
        } else if ("vendorId" in identifier && "productId" in identifier) {
            foundRecords.push(
                ...storedRecords.filter(({ V, P }) => V === identifier.vendorId && P === identifier.productId),
            );
        } else if ("vendorId" in identifier) {
            foundRecords.push(...storedRecords.filter(({ V }) => V === identifier.vendorId));
        } else if ("deviceType" in identifier) {
            foundRecords.push(...storedRecords.filter(({ DT }) => DT === identifier.deviceType));
        } else if ("productId" in identifier) {
            foundRecords.push(...storedRecords.filter(({ P }) => P === identifier.productId));
        } else if (Object.keys(identifier).length === 0) {
            foundRecords.push(...storedRecords.filter(({ CM }) => CM === 1 || CM === 2));
        }

        return foundRecords.map(record => {
            return {
                ...record,
                addresses: this.#sortServerEntries(Array.from(record.addresses.values())).map(({ ip, port }) => ({
                    ip,
                    port,
                    type: "udp",
                })) as ServerAddressIp[],
                expires: undefined,
            };
        });
    }

    /**
     * Builds an identifier string for commissionable queries based on the given identifier object.
     * Some identifiers are identical to the official DNS-SD identifiers, others are custom.
     */
    #buildCommissionableQueryIdentifier(identifier: CommissionableDeviceIdentifiers) {
        if ("instanceId" in identifier) {
            return getDeviceInstanceQname(identifier.instanceId);
        }

        if ("longDiscriminator" in identifier) {
            return getLongDiscriminatorQname(identifier.longDiscriminator);
        }

        if ("shortDiscriminator" in identifier) {
            return getShortDiscriminatorQname(identifier.shortDiscriminator);
        }

        if ("vendorId" in identifier && "productId" in identifier) {
            // Custom identifier because normally productId is only included in TXT record
            return `_VP${identifier.vendorId}+${identifier.productId}`;
        }

        if ("vendorId" in identifier) {
            return getVendorQname(identifier.vendorId);
        }

        if ("deviceType" in identifier) {
            return getDeviceTypeQname(identifier.deviceType);
        }

        if ("productId" in identifier) {
            // Custom identifier because normally productId is only included in TXT record
            return `_P${identifier.productId}`;
        }

        return getCommissioningModeQname();
    }

    #extractInstanceId(instanceName: string) {
        const instanceNameSeparator = instanceName.indexOf(".");
        if (instanceNameSeparator !== -1) {
            return instanceName.substring(0, instanceNameSeparator);
        }
        return instanceName;
    }

    /**
     * Check all options for a query identifier and return the most relevant one with an active query
     */
    #findCommissionableQueryIdentifier(instanceName: string, record: CommissionableDeviceRecordWithExpire) {
        if (this.#closing) {
            throw new ImplementationError("Cannot discover commissionable device because scanner is closing.");
        }
        const instanceQueryId = this.#buildCommissionableQueryIdentifier({
            instanceId: this.#extractInstanceId(instanceName),
        });
        if (this.#activeAnnounceQueries.has(instanceQueryId)) {
            return instanceQueryId;
        }

        const longDiscriminatorQueryId = this.#buildCommissionableQueryIdentifier({ longDiscriminator: record.D });
        if (this.#activeAnnounceQueries.has(longDiscriminatorQueryId)) {
            return longDiscriminatorQueryId;
        }

        const shortDiscriminatorQueryId = this.#buildCommissionableQueryIdentifier({ shortDiscriminator: record.SD });
        if (this.#activeAnnounceQueries.has(shortDiscriminatorQueryId)) {
            return shortDiscriminatorQueryId;
        }

        if (record.V !== undefined && record.P !== undefined) {
            const vendorProductIdQueryId = this.#buildCommissionableQueryIdentifier({
                vendorId: VendorId(record.V),
                productId: record.P,
            });
            if (this.#activeAnnounceQueries.has(vendorProductIdQueryId)) {
                return vendorProductIdQueryId;
            }
        }

        if (record.V !== undefined) {
            const vendorIdQueryId = this.#buildCommissionableQueryIdentifier({ vendorId: VendorId(record.V) });
            if (this.#activeAnnounceQueries.has(vendorIdQueryId)) {
                return vendorIdQueryId;
            }
        }

        if (record.DT !== undefined) {
            const deviceTypeQueryId = this.#buildCommissionableQueryIdentifier({ deviceType: record.DT });
            if (this.#activeAnnounceQueries.has(deviceTypeQueryId)) {
                return deviceTypeQueryId;
            }
        }

        if (record.P !== undefined) {
            const productIdQueryId = this.#buildCommissionableQueryIdentifier({ productId: record.P });
            if (this.#activeAnnounceQueries.has(productIdQueryId)) {
                return productIdQueryId;
            }
        }

        const commissioningModeQueryId = this.#buildCommissionableQueryIdentifier({});
        if (this.#activeAnnounceQueries.has(commissioningModeQueryId)) {
            return commissioningModeQueryId;
        }

        return undefined;
    }

    #getCommissionableQueryRecords(identifier: CommissionableDeviceIdentifiers): DnsQuery[] {
        const names = new Array<string>();

        names.push(MATTER_COMMISSION_SERVICE_QNAME);

        if ("instanceId" in identifier) {
            names.push(getDeviceInstanceQname(identifier.instanceId));
        } else if ("longDiscriminator" in identifier) {
            names.push(getLongDiscriminatorQname(identifier.longDiscriminator));
        } else if ("shortDiscriminator" in identifier) {
            names.push(getShortDiscriminatorQname(identifier.shortDiscriminator));
        } else if ("vendorId" in identifier) {
            names.push(getVendorQname(identifier.vendorId));
        } else if ("deviceType" in identifier) {
            names.push(getDeviceTypeQname(identifier.deviceType));
        } else {
            // Other queries just scan for commissionable devices
            names.push(getCommissioningModeQname());
        }

        return names.map(name => ({ name, recordClass: DnsRecordClass.IN, recordType: DnsRecordType.PTR }));
    }

    /**
     * Discovers commissionable devices based on a defined identifier for maximal given timeout, but returns the
     * first found entries. If already a discovered device matches in the cache the response is returned directly and
     * no query is triggered. If no record exists a query is sent out and the promise gets fulfilled as soon as at least
     * one device is found. If no device is discovered in the defined timeframe an empty array is returned. When the
     * promise got fulfilled no more queries are send out, but more device entries might be added when discovered later.
     * These can be requested by the getCommissionableDevices method.
     */
    async findCommissionableDevices(
        identifier: CommissionableDeviceIdentifiers,
        timeoutSeconds = 5,
        ignoreExistingRecords = false,
    ): Promise<CommissionableDevice[]> {
        let storedRecords = ignoreExistingRecords
            ? []
            : this.#getCommissionableDeviceRecords(identifier).filter(({ addresses }) => addresses.length > 0);
        if (storedRecords.length === 0) {
            const queryId = this.#buildCommissionableQueryIdentifier(identifier);
            const promise = this.#registerWaiterPromise(queryId, timeoutSeconds);

            this.#setQueryRecords(queryId, this.#getCommissionableQueryRecords(identifier));

            await promise;
            storedRecords = this.#getCommissionableDeviceRecords(identifier);
            this.#removeQuery(queryId);
        }

        return storedRecords;
    }

    /**
     * Discovers commissionable devices based on a defined identifier and returns the first found entries. If already a
     * @param identifier
     * @param callback
     * @param timeoutSeconds
     */
    async findCommissionableDevicesContinuously(
        identifier: CommissionableDeviceIdentifiers,
        callback: (device: CommissionableDevice) => void,
        timeoutSeconds?: number,
        cancelSignal?: Promise<void>,
    ): Promise<CommissionableDevice[]> {
        const discoveredDevices = new Set<string>();

        const discoveryEndTime = timeoutSeconds ? Time.nowMs() + timeoutSeconds * 1000 : undefined;
        const queryId = this.#buildCommissionableQueryIdentifier(identifier);
        this.#setQueryRecords(queryId, this.#getCommissionableQueryRecords(identifier));

        let canceled = false;
        cancelSignal?.then(
            () => {
                canceled = true;
                this.#finishWaiter(queryId, true);
            },
            cause => {
                logger.error("Unexpected error canceling commissioning", cause);
            },
        );

        while (!canceled) {
            this.#getCommissionableDeviceRecords(identifier).forEach(device => {
                const { deviceIdentifier } = device;
                if (!discoveredDevices.has(deviceIdentifier)) {
                    discoveredDevices.add(deviceIdentifier);
                    callback(device);
                }
            });

            let remainingTime;
            if (discoveryEndTime !== undefined) {
                const remainingTime = Math.ceil((discoveryEndTime - Time.nowMs()) / 1000);
                if (remainingTime <= 0) {
                    break;
                }
            }
            await this.#registerWaiterPromise(queryId, remainingTime, false);
        }
        return this.#getCommissionableDeviceRecords(identifier);
    }

    getDiscoveredCommissionableDevices(identifier: CommissionableDeviceIdentifiers) {
        return this.#getCommissionableDeviceRecords(identifier);
    }

    /**
     * Close all connects, end all timers and resolve all pending promises.
     */
    async close() {
        this.#closing = true;
        this.#periodicTimer.stop();
        this.#queryTimer?.stop();
        await this.#multicastServer.close();
        // Resolve all pending promises where logic waits for the response (aka: has a timer)
        [...this.#recordWaiters.keys()].forEach(queryId =>
            this.#finishWaiter(queryId, !!this.#recordWaiters.get(queryId)?.timer),
        );
    }

    /**
     * Main method to handle all incoming DNS messages.
     * It will parse the message and check if it contains relevant discovery records.
     */
    #handleDnsMessage(messageBytes: Uint8Array, _remoteIp: string, netInterface: string) {
        if (this.#closing) return;
        const message = DnsCodec.decode(messageBytes);
        if (message === undefined) return; // The message cannot be parsed
        if (message.messageType !== DnsMessageType.Response && message.messageType !== DnsMessageType.TruncatedResponse)
            return;

        const answers = [...message.answers, ...message.additionalRecords];

        // Check if we got operational discovery records and handle them
        if (this.#handleOperationalRecords(answers, this.#getActiveQueryEarlierAnswers(), netInterface)) return;

        // Else check if we got commissionable discovery records and handle them
        this.#handleCommissionableRecords(answers, this.#getActiveQueryEarlierAnswers(), netInterface);
    }

    #handleIpRecords(
        answers: DnsRecord<any>[],
        target: string,
        netInterface: string,
    ): { value: string; ttl: number }[] {
        const ipRecords = answers.filter(
            ({ name, recordType }) =>
                ((recordType === DnsRecordType.A && this.#enableIpv4) || recordType === DnsRecordType.AAAA) &&
                name === target,
        );
        return (ipRecords as DnsRecord<string>[]).map(({ value, ttl }) => ({
            value: value.startsWith("fe80::") ? `${value}%${netInterface}` : value,
            ttl,
        }));
    }

    #handleOperationalRecords(answers: DnsRecord<any>[], formerAnswers: DnsRecord<any>[], netInterface: string) {
        let recordsHandled = false;
        // Does the message contain data for an operational service?
        const operationalTxtRecord = answers.find(
            ({ name, recordType }) => recordType === DnsRecordType.TXT && name.endsWith(MATTER_SERVICE_QNAME),
        );
        if (operationalTxtRecord !== undefined) {
            this.#handleOperationalTxtRecord(operationalTxtRecord, netInterface);
            recordsHandled = true;
        }

        const operationalSrvRecord =
            answers.find(
                ({ name, recordType }) => recordType === DnsRecordType.SRV && name.endsWith(MATTER_SERVICE_QNAME),
            ) ??
            formerAnswers.find(
                ({ name, recordType }) => recordType === DnsRecordType.SRV && name.endsWith(MATTER_SERVICE_QNAME),
            );

        if (operationalSrvRecord !== undefined) {
            this.#handleOperationalSrvRecord(operationalSrvRecord, answers, formerAnswers, netInterface);
            recordsHandled = true;
        }
        return recordsHandled;
    }

    #handleOperationalTxtRecord(record: DnsRecord<any>, netInterface: string) {
        const { name: matterName, value, ttl } = record as DnsRecord<string[]>;

        // we got an expiry info, so we can remove the record if we know it already and are done
        if (ttl === 0) {
            if (this.#operationalDeviceRecords.has(matterName)) {
                logger.debug(
                    `Removing operational device ${matterName} from cache (interface ${netInterface}) because of ttl=0`,
                );
                this.#operationalDeviceRecords.delete(matterName);
            }
            return;
        }
        if (!Array.isArray(value)) return;

        const txtData = this.#parseTxtRecord(record);
        if (txtData === undefined) return;
        let device = this.#operationalDeviceRecords.get(matterName);
        if (device !== undefined) {
            device = {
                ...device,
                discoveredAt: Time.nowMs(),
                ttl: ttl * 1000,
                ...txtData,
            };
        } else {
            logger.debug(
                `Adding operational device ${matterName} in cache (interface ${netInterface}) with TXT data:`,
                MdnsScanner.discoveryDataDiagnostics(txtData),
            );
            device = {
                deviceIdentifier: matterName,
                addresses: new Map<string, MatterServerRecordWithExpire>(),
                discoveredAt: Time.nowMs(),
                ttl: ttl * 1000,
                ...txtData,
            };
        }

        this.#operationalDeviceRecords.set(matterName, device);
    }

    #handleOperationalSrvRecord(
        record: DnsRecord<any>,
        answers: DnsRecord<any>[],
        formerAnswers: DnsRecord<any>[],
        netInterface: string,
    ) {
        const {
            name: matterName,
            ttl,
            value: { target, port },
        } = record;

        // we got an expiry info, so we can remove the record if we know it already and are done
        if (ttl === 0) {
            if (this.#operationalDeviceRecords.has(matterName)) {
                logger.debug(
                    `Removing operational device ${matterName} from cache (interface ${netInterface}) because of ttl=0`,
                );
                this.#operationalDeviceRecords.delete(matterName);
            }
            return true;
        }

        const ips = this.#handleIpRecords([...answers, ...formerAnswers], target, netInterface);
        const deviceExisted = this.#operationalDeviceRecords.has(matterName);
        const device = this.#operationalDeviceRecords.get(matterName) ?? {
            deviceIdentifier: matterName,
            addresses: new Map<string, MatterServerRecordWithExpire>(),
            discoveredAt: Time.nowMs(),
            ttl: ttl * 1000,
        };
        const { addresses } = device;
        if (ips.length > 0) {
            for (const { value: ip, ttl } of ips) {
                if (ttl === 0) {
                    logger.debug(
                        `Removing IP ${ip} for operational device ${matterName} from cache (interface ${netInterface}) because of ttl=0`,
                    );
                    addresses.delete(ip);
                    continue;
                }
                const matterServer = addresses.get(ip) ?? ({ ip, port, type: "udp" } as MatterServerRecordWithExpire);
                matterServer.discoveredAt = Time.nowMs() + ttl * 1000;

                addresses.set(matterServer.ip, matterServer);
            }
            device.addresses = addresses;
            if (!this.#operationalDeviceRecords.has(matterName)) {
                logger.debug(
                    `Added IPs for operational device ${matterName} to cache (interface ${netInterface}):`,
                    ...MdnsScanner.deviceAddressDiagnostics(addresses),
                );
            }
            this.#operationalDeviceRecords.set(matterName, device);
        }

        if (addresses.size === 0 && this.#hasWaiter(matterName)) {
            // We have no or no more (because expired) IPs, and we are interested in this particular service name, request them
            const queries = [{ name: target, recordClass: DnsRecordClass.IN, recordType: DnsRecordType.AAAA }];
            if (this.#enableIpv4) {
                queries.push({ name: target, recordClass: DnsRecordClass.IN, recordType: DnsRecordType.A });
            }
            logger.debug(`Requesting IP addresses for operational device ${matterName} (interface ${netInterface}).`);
            this.#setQueryRecords(matterName, queries, answers);
        } else if (addresses.size > 0) {
            this.#finishWaiter(matterName, true, deviceExisted);
        }
        return true;
    }

    #handleCommissionableRecords(answers: DnsRecord<any>[], formerAnswers: DnsRecord<any>[], netInterface: string) {
        // Does the message contain a SRV record for an operational service we are interested in?
        let commissionableRecords = answers.filter(({ name }) => name.endsWith(MATTER_COMMISSION_SERVICE_QNAME));
        if (!commissionableRecords.length) {
            commissionableRecords = formerAnswers.filter(({ name }) => name.endsWith(MATTER_COMMISSION_SERVICE_QNAME));
            if (!commissionableRecords.length) return;
        }

        const queryMissingDataForInstances = new Set<string>();

        // First process the TXT records
        const txtRecords = commissionableRecords.filter(({ recordType }) => recordType === DnsRecordType.TXT);
        for (const record of txtRecords) {
            const { name, ttl } = record;
            if (ttl === 0) {
                if (this.#commissionableDeviceRecords.has(name)) {
                    logger.debug(
                        `Removing commissionable device ${name} from cache (interface ${netInterface}) because of ttl=0`,
                    );
                    this.#commissionableDeviceRecords.delete(name);
                }
                continue;
            }
            const parsedRecord = this.#parseCommissionableTxtRecord(record);
            if (parsedRecord === undefined) continue;
            parsedRecord.instanceId = this.#extractInstanceId(name);
            parsedRecord.deviceIdentifier = parsedRecord.instanceId;
            if (parsedRecord.D !== undefined && parsedRecord.SD === undefined) {
                parsedRecord.SD = (parsedRecord.D >> 8) & 0x0f;
            }
            if (parsedRecord.VP !== undefined) {
                const VpValueArr = parsedRecord.VP.split("+");
                parsedRecord.V = VpValueArr[0] !== undefined ? parseInt(VpValueArr[0]) : undefined;
                parsedRecord.P = VpValueArr[1] !== undefined ? parseInt(VpValueArr[1]) : undefined;
            }

            const storedRecord = this.#commissionableDeviceRecords.get(name);
            if (storedRecord === undefined) {
                queryMissingDataForInstances.add(name);

                logger.debug(
                    `Found commissionable device ${name} with data:`,
                    MdnsScanner.discoveryDataDiagnostics(parsedRecord),
                );
            } else {
                parsedRecord.addresses = storedRecord.addresses;
            }
            this.#commissionableDeviceRecords.set(name, parsedRecord);
        }

        // We got SRV records for the instance ID, so we know the host name now and can collect the IP addresses
        const srvRecords = commissionableRecords.filter(({ recordType }) => recordType === DnsRecordType.SRV);
        for (const record of srvRecords) {
            const storedRecord = this.#commissionableDeviceRecords.get(record.name);
            if (storedRecord === undefined) continue;
            const {
                value: { target, port },
                ttl,
            } = record as DnsRecord<SrvRecordValue>;
            if (ttl === 0) {
                logger.debug(
                    `Removing commissionable device ${record.name} from cache (interface ${netInterface}) because of ttl=0`,
                );
                this.#commissionableDeviceRecords.delete(record.name);
                continue;
            }

            const recordExisting = storedRecord.addresses.size > 0;

            const ips = this.#handleIpRecords([...answers, ...formerAnswers], target, netInterface);
            if (ips.length > 0) {
                for (const { value: ip, ttl } of ips) {
                    if (ttl === 0) {
                        logger.debug(
                            `Removing IP ${ip} for commissionable device ${record.name} from cache (interface ${netInterface}) because of ttl=0`,
                        );
                        storedRecord.addresses.delete(ip);
                        continue;
                    }
                    const matterServer =
                        storedRecord.addresses.get(ip) ?? ({ ip, port, type: "udp" } as MatterServerRecordWithExpire);
                    matterServer.discoveredAt = Time.nowMs();
                    matterServer.ttl = ttl * 1000;

                    storedRecord.addresses.set(ip, matterServer);
                }
            }
            this.#commissionableDeviceRecords.set(record.name, storedRecord);
            if (storedRecord.addresses.size === 0) {
                const queryId = this.#findCommissionableQueryIdentifier("", storedRecord);
                if (queryId === undefined) continue;
                // We have no or no more (because expired) IPs and we are interested in such a service name, request them
                const queries = [{ name: target, recordClass: DnsRecordClass.IN, recordType: DnsRecordType.AAAA }];
                if (this.#enableIpv4) {
                    queries.push({ name: target, recordClass: DnsRecordClass.IN, recordType: DnsRecordType.A });
                }
                logger.debug(
                    `Requesting IP addresses for commissionable device ${record.name} (interface ${netInterface}).`,
                );
                this.#setQueryRecords(queryId, queries, answers);
            }
            if (storedRecord.addresses.size === 0) continue;

            const queryId = this.#findCommissionableQueryIdentifier(record.name, storedRecord);
            if (queryId === undefined) continue;

            queryMissingDataForInstances.delete(record.name); // No need to query anymore, we have anything we need
            this.#finishWaiter(queryId, true, recordExisting);
        }

        // We have to query for the SRV records for the missing commissionable devices where we only had TXT records
        if (queryMissingDataForInstances.size !== 0) {
            for (const name of Array.from(queryMissingDataForInstances.values())) {
                const storedRecord = this.#commissionableDeviceRecords.get(name);
                if (storedRecord === undefined) continue;
                const queryId = this.#findCommissionableQueryIdentifier("", storedRecord);
                if (queryId === undefined) continue;
                logger.debug(`Requesting more records for commissionable device ${name} (interface ${netInterface}).`);
                this.#setQueryRecords(
                    queryId,
                    [{ name, recordClass: DnsRecordClass.IN, recordType: DnsRecordType.ANY }],
                    answers,
                );
            }
        }
    }

    #parseTxtRecord(record: DnsRecord<any>): DiscoveryData | undefined {
        const { value } = record as DnsRecord<string[]>;
        const result = {} as any;
        if (Array.isArray(value)) {
            for (const item of value) {
                const [key, value] = item.split("=");
                if (key === undefined || value === undefined) continue;
                if (["SII", "SAI", "SAT", "T", "D", "CM", "DT", "PH", "ICD"].includes(key)) {
                    const intValue = parseInt(value);
                    if (isNaN(intValue)) continue;
                    result[key] = intValue;
                } else if (["VP", "DN", "RI", "PI"].includes(key)) {
                    result[key] = value;
                }
            }
        }

        // Fill in some defaults for convenience
        if (result.T === undefined) {
            result.T = 0; // TCP not supported
        } else if (result.T === 1) {
            // Value 1 is reserved and should be handled as 0 according to Matter spec
            result.T = 0; // TCP not supported
        }
        if (result.ICD === undefined) {
            result.ICD = 0; // Device is not operating as Long Idle Time ICD
        }

        return result;
    }

    #parseCommissionableTxtRecord(record: DnsRecord<any>): CommissionableDeviceRecordWithExpire | undefined {
        const { value, ttl } = record as DnsRecord<string[]>;
        if (!Array.isArray(value)) return undefined;
        const result = {
            addresses: new Map<string, ServerAddress>(),
            expires: Time.nowMs() + ttl * 1000,
            ...this.#parseTxtRecord(record),
        } as any;
        if (result.D === undefined || result.CM === undefined) return undefined; // Required data fields need to be existing
        return result as CommissionableDeviceRecordWithExpire;
    }

    #expire() {
        const now = Time.nowMs();
        [...this.#operationalDeviceRecords.entries()].forEach(([recordKey, { addresses, discoveredAt, ttl }]) => {
            const expires = discoveredAt + ttl;
            if (now < expires) {
                [...addresses.entries()].forEach(([key, { discoveredAt, ttl }]) => {
                    if (now < discoveredAt + ttl) return;
                    addresses.delete(key);
                });
            }
            if (now >= expires || addresses.size === 0) {
                this.#operationalDeviceRecords.delete(recordKey);
            }
        });
        [...this.#commissionableDeviceRecords.entries()].forEach(([recordKey, { addresses, discoveredAt, ttl }]) => {
            const expires = discoveredAt + ttl;
            if (now < expires) {
                // Entry still ok but check addresses for expiry
                [...addresses.entries()].forEach(([key, { discoveredAt, ttl }]) => {
                    if (now < discoveredAt + ttl) return;
                    addresses.delete(key);
                });
            }
            if (now >= expires || addresses.size === 0) {
                this.#commissionableDeviceRecords.delete(recordKey);
            }
        });
    }

    static discoveryDataDiagnostics(data: DiscoveryData) {
        return Diagnostic.dict({
            SII: data.SII,
            SAI: data.SAI,
            SAT: data.SAT,
            T: data.T,
            DT: data.DT,
            PH: data.PH,
            ICD: data.ICD,
            VP: data.VP,
            DN: data.DN,
            RI: data.RI,
            PI: data.PI,
        });
    }

    static deviceAddressDiagnostics(addresses: Map<string, MatterServerRecordWithExpire>) {
        return Array.from(addresses.values()).map(address =>
            Diagnostic.dict({
                ip: address.ip,
                port: address.port,
                type: address.type,
            }),
        );
    }
}
