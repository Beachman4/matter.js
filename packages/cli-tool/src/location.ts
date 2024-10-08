/**
 * @license
 * Copyright 2022-2024 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { NotADirectoryError, NotFoundError } from "#errors.js";
import { decamelize, MaybePromise } from "#general";
import { Stat } from "#stat.js";

/**
 * We support a quick-and-dirty virtual "filesystem" for navigation of our object model.
 *
 * This is the interface to this filesystem.
 */
export interface Location {
    kind: "directory" | "command" | "file";
    basename: string;
    path: string;
    tag: string;
    id?: string | number;
    name?: string;
    summary?: string;
    parent?: Location;
    definition: unknown;
    paths: MaybePromise<string[]>;
    at(path: string, searchedAs?: string): MaybePromise<Location>;
    maybeAt(path: string, searchedAs?: string): MaybePromise<Location | undefined>;
}

function isClass(fn: {}) {
    return !Object.getOwnPropertyDescriptor(fn, "prototype")?.writable;
}

export function Location(basename: string, definition: unknown, stat: Stat, parent: undefined | Location): Location {
    let { tag } = stat;

    if (tag === undefined) {
        if (definition === undefined) {
            tag = "undefined";
        } else if (typeof definition === "object") {
            if (definition === null) {
                tag = "null";
            } else if (Symbol.toStringTag in definition) {
                tag = `${definition[Symbol.toStringTag]}`;
            } else if (Array.isArray(definition)) {
                tag = "array";
            } else if (ArrayBuffer.isView(definition)) {
                tag = "bytes";
            } else if (definition && definition.constructor.name !== "Object") {
                tag = definition.constructor.name;
            } else {
                tag = "object";
            }
        } else if (typeof definition === "function") {
            if (isClass(definition)) {
                tag = "constructor";
            } else {
                tag = "function";
            }
        } else {
            tag = typeof definition;
        }
    }

    tag = decamelize(tag);

    return {
        kind: typeof definition === "function" && !isClass(definition) ? "command" : stat.kind,
        basename,
        name: stat.name,
        summary: stat.summary,
        id: stat.id,
        tag,
        parent,
        definition,

        get path() {
            if (!this.parent) {
                return "/";
            }

            let path = "";
            let location = this;
            while (location.parent) {
                path = `/${location.basename}${path}`;
                location = location.parent;
            }
            return path;
        },

        get paths() {
            if (stat.kind !== "directory") {
                throw new NotADirectoryError(this.path);
            }
            return stat.paths;
        },

        at(path, searchedAs): MaybePromise<Location> {
            const location = this.maybeAt(path);

            if (MaybePromise.is(location)) {
                return location.then(accept);
            }

            return accept(location);

            function accept(location: Location | undefined) {
                if (location === undefined) {
                    throw new NotFoundError(searchedAs ?? path);
                }

                return location;
            }
        },

        maybeAt(path, searchedAs): MaybePromise<Location | undefined> {
            if (stat.kind !== "directory") {
                throw new NotADirectoryError(searchedAs ?? path);
            }

            if (path === undefined || path === "") {
                return this;
            }

            const segments = path.split("/");

            // Handle absolute path.  Does not happen on recursion
            if (segments[0] === "") {
                let location = this;
                while (location.parent) {
                    location = location.parent;
                }
                return location.maybeAt(segments.slice(1).join("/"), "/");
            }

            while (segments[0] === "" || segments[0] === ".") {
                searchedAs += `${segments.shift()}/`;
            }

            if (segments[0] === "..") {
                return (this.parent ?? this).maybeAt(
                    segments.slice(1).join("/"),
                    searchedAs ? Location.join(searchedAs, "..") : "..",
                );
            }

            if (!segments.length) {
                return this;
            }

            const subsearchedAs = searchedAs ? Location.join(searchedAs, segments[0]) : segments[0];
            const definition = stat.definitionAt(decodeURIComponent(segments[0]));

            const accept = (definition: unknown) => {
                if (definition === undefined || definition === null) {
                    if (segments.length > 1) {
                        throw new NotFoundError(subsearchedAs);
                    }
                    return;
                }

                const sublocation = Location(segments[0], definition, Stat.of(definition), this);
                if (segments.length === 1) {
                    return sublocation;
                }

                return sublocation.at(segments.slice(1).join("/"), subsearchedAs);
            };

            if (MaybePromise.is(definition)) {
                return definition.then(accept);
            }

            return accept(definition);
        },
    };
}

export namespace Location {
    export function join(path: string, ...paths: string[]) {
        for (const other of paths) {
            if (other.startsWith("/")) {
                path = other;
            } else if (path.endsWith("/")) {
                path = `${path}${other}`;
            } else {
                path = `${path}/${other}`;
            }
        }
        return path;
    }
}
