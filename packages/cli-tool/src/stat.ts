/**
 * @license
 * Copyright 2022-2024 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MaybePromise } from "@matter/general";

/**
 * An object that does not contain subobjects in our virtual filesystem.
 */
export interface File extends Stat.Base {
    kind: "file";
}

/**
 * An object that contains sub-objects in our virtual filesystem.
 */
export interface Directory extends Stat.Base {
    kind: "directory";
    paths: MaybePromise<string[]>;
    definitionAt(path: string): MaybePromise<unknown>;
}

export function Directory(options: {
    id?: number | string;
    tag?: string;
    name?: string;
    summary?: string;
    paths: () => MaybePromise<string[]>;
    definitionAt: (path: string) => MaybePromise<unknown>;
}): Directory {
    const { name, summary, id, tag, paths, definitionAt } = options;
    return {
        kind: "directory",
        name,
        summary,
        id,
        tag,

        get paths() {
            return paths();
        },

        definitionAt(path: string) {
            return definitionAt(path);
        },
    };
}

export type Stat = File | Directory;

/**
 * Augments information about "filesystem" locations.
 */
export interface StatProvider {
    (definition: unknown): undefined | Stat;
}

const providers = Array<StatProvider>();

export namespace Stat {
    export interface Base {
        name?: string;
        summary?: string;
        id?: number | string;
        tag?: string;
    }

    /**
     * Obtain an Inode for a JS value.
     */
    export function of(definition: unknown): Stat {
        for (const provider of providers) {
            const stat = provider(definition);
            if (stat) {
                return stat;
            }
        }

        if (isDirectory(definition)) {
            return {
                kind: "directory",

                get paths() {
                    return Object.keys(definition);
                },

                definitionAt(path: string) {
                    if (path in definition) {
                        return definition[path];
                    }
                },
            };
        }

        return {
            kind: "file",
        };
    }

    /**
     * Register a provider.
     */
    export function provide(provider: StatProvider) {
        providers.push(provider);
    }

    /**
     * Determine if we consider an object a "directory".
     */
    export function isDirectory(definition: unknown): definition is Record<string, unknown> {
        return (
            typeof definition === "object" &&
            definition !== null &&
            !Array.isArray(definition) &&
            !ArrayBuffer.isView(definition) &&
            !(definition instanceof Date)
        );
    }
}
