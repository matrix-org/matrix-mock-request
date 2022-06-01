/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import expect from 'expect';

type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';
type Callback = (err?: Error, response?: XMLHttpRequest, body?: string) => void;
type RequestOpts = {
    method: HttpMethod;
    uri: string;
    body?: string;
    qs?: Record<string, string>;
    headers?: Record<string, string>;
}

/**
 * Construct a mock HTTP backend, heavily inspired by Angular.js.
 * @constructor
 */
class HttpBackend {
    public requests: Request[] = [];
    public expectedRequests: ExpectedRequest[] = [];

    // All the promises our flush requests have returned. When all these promises are
    // resolved or rejected, there are no more flushes in progress.
    // For simplicity we never remove promises from this loop: this is a mock utility
    // for short duration tests, so this keeps it simpler.
    public _flushPromises: Promise<unknown>[] = [];

    // the request function dependency that the SDK needs.
    public requestFn = (opts: RequestOpts, callback: Callback): {
        abort: () => void;
    } => {
        const req = new Request(opts, callback);
        console.log(`${Date.now()} HTTP backend received request: ${req}`);
        this.requests.push(req);

        const self = this;

        const abort = function() {
            const idx = self.requests.indexOf(req);
            if (idx >= 0) {
                console.log("Aborting HTTP request: %s %s", opts.method,
                            opts.uri);
                self.requests.splice(idx, 1);
                // @TODO replace this with AbortError and remove special handling in js-sdk
                // @ts-ignore
                req.callback("aborted");
            }
        };

        return {
            abort: abort,
        };
    };

    // very simplistic mapping from the whatwg fetch interface onto the request
    // interface, so we can use the same mock backend for both.
    public fetchFn = (input: string, init?: Omit<RequestOpts, 'uri'>): Promise<{ ok: boolean, json: () => unknown }> => {
        const requestOpts = {
            uri: input,
            method: init?.method || 'GET',
            body: init?.body,
        };

        return new Promise((resolve, reject) => {
            function callback(err, response, body) {
                if (err) {
                    reject(err);
                }
                resolve({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    json: () => JSON.parse(body),
                });
            };

            const req = new Request(requestOpts, callback);
            console.log(`HTTP backend received request: ${req}`);
            this.requests.push(req);
        });
    };

    /**
     * Respond to all of the requests (flush the queue).
     * @param {string} path The path to flush (optional) default: all.
     * @param {integer} numToFlush The number of things to flush (optional), default: all.
     * @param {integer=} waitTime  The time (in ms) to wait for a request to happen.
     *    default: 100
     *
     * @return {Promise} resolves when there is nothing left to flush, with the
     *    number of requests flushed
     */
    public flush = (path: string | undefined, numToFlush?: number, waitTime?: number): Promise<number> => {
        const self = this;
        const promise = new Promise<number>((resolve, reject) => {
            let flushed = 0;
            if (waitTime === undefined) {
                waitTime = 100;
            }

            function log(msg) {
                console.log(`${Date.now()} flush[${path || ''}]: ${msg}`);
            }
            log("HTTP backend flushing... (path=" + path
                + " numToFlush=" + numToFlush
                + " waitTime=" + waitTime
                + ")"
            );
            const endTime = waitTime + Date.now();

            const tryFlush = function() {
                try {
                    _tryFlush();
                } catch (e) {
                    reject(e);
                }
            };

            const _tryFlush = function() {
                // if there's more real requests and more expected requests, flush 'em.
                log(`  trying to flush => reqs=[${self.requests}] ` +
                    `expected=[${self.expectedRequests}]`
                );
                if (self._takeFromQueue(path)) {
                    // try again on the next tick.
                    flushed += 1;
                    if (numToFlush && flushed === numToFlush) {
                        log(`Flushed assigned amount: ${numToFlush}`);
                        resolve(flushed);
                    } else {
                        log(`  flushed. Trying for more.`);
                        setTimeout(tryFlush, 0);
                    }
                } else if ((flushed === 0 || (numToFlush && numToFlush > flushed))
                    && Date.now() < endTime) {
                    // we may not have made the request yet, wait a generous amount of
                    // time before giving up.
                    log(`  nothing to flush yet; waiting for requests.`);
                    setTimeout(tryFlush, 5);
                } else {
                    if (flushed === 0) {
                        log("nothing to flush; giving up");
                    } else {
                        log(`no more flushes after flushing ${flushed} requests`);
                    }
                    resolve(flushed);
                }
            };

            setTimeout(tryFlush, 0);
        });

        this._flushPromises.push(promise);

        return promise;
    }

    /**
     * Repeatedly flush requests until the list of expectations is empty.
     *
     * There is a total timeout (of 1000ms by default), after which the returned
     * promise is rejected.
     *
     * @param {Object=} opts Options object
     * @param {Number=} opts.timeout Total timeout, in ms. 1000 by default.
     * @return {Promise} resolves when there is nothing left to flush, with the
     *    number of requests flushed
     */
    public flushAllExpected = (opts: { timeout?: number } = {}): Promise<number> => {
        opts = opts || {};

        if (this.expectedRequests.length === 0) {
            // calling flushAllExpected when there are no expectations is a
            // silly thing to do, and probably means that your test isn't
            // doing what you think it is doing (or it is racy). Hence we
            // reject this, rather than resolving immediately.
            return Promise.reject(new Error(
                `flushAllExpected called with an empty expectation list`,
            ));
        }

        const waitTime = opts.timeout === undefined ? 1000 : opts.timeout;
        const endTime = waitTime + Date.now();
        let flushed = 0;

        const iterate = () => {
            const timeRemaining = endTime - Date.now();
            if (timeRemaining <= 0) {
                throw new Error(
                    `Timed out after flushing ${flushed} requests; `+
                    `${this.expectedRequests.length} remaining`,
                );
            }

            return this.flush(
                undefined, undefined, timeRemaining,
            ).then((f) => {
                flushed += f;

                if (this.expectedRequests.length === 0) {
                    // we're done
                    return null;
                }

                return iterate();
            });
        };

        const prom = new Promise<number>((resolve, reject) => {
            iterate().then(() => {
                resolve(flushed);
            }, (e) => {
                reject(e);
            });
        });
        this._flushPromises.push(prom);
        return prom;
    }


    /**
     * Attempts to resolve requests/expected requests.
     * @param {string} path The path to flush (optional) default: all.
     * @return {boolean} true if something was resolved.
     */
    private _takeFromQueue = (path: string): boolean => {
        let req = null;
        let i;
        let j;
        let matchingReq = null;
        let expectedReq = null;
        let testResponse = null;
        for (i = 0; i < this.requests.length; i++) {
            req = this.requests[i];
            for (j = 0; j < this.expectedRequests.length; j++) {
                expectedReq = this.expectedRequests[j];
                if (path && path !== expectedReq.path) {
                    continue;
                }
                if (expectedReq.method === req.method &&
                        req.path.indexOf(expectedReq.path) !== -1) {
                    if (!expectedReq.data || (JSON.stringify(expectedReq.data) ===
                            JSON.stringify(req.data))) {
                        matchingReq = expectedReq;
                        this.expectedRequests.splice(j, 1);
                        break;
                    }
                }
            }

            if (matchingReq) {
                // remove from request queue
                this.requests.splice(i, 1);
                i--;

                for (j = 0; j < matchingReq.checks.length; j++) {
                    matchingReq.checks[j](req);
                }
                testResponse = matchingReq.response;
                console.log(`${Date.now()}    responding to ${matchingReq.path}`);

                let body = testResponse.body;
                if (Object.prototype.toString.call(body) == "[object Function]") {
                    body = body(req.path, req.data, req);
                }

                if (!testResponse.rawBody) {
                    body = JSON.stringify(body);
                }
                req.callback(
                    testResponse.err, testResponse.response, body,
                );
                matchingReq = null;
            }
        }
        if (testResponse) {  // flushed something
            return true;
        }
        return false;
    }

    /**
     * Makes sure that the SDK hasn't sent any more requests to the backend.
     */
    public verifyNoOutstandingRequests = (): void => {
        const firstOutstandingReq = this.requests[0];
        expect(this.requests.length).toEqual(0,
            "Expected no more HTTP requests but received request to " +
            firstOutstandingReq?.path,
        );
    }

    /**
     * Makes sure that the test doesn't have any unresolved requests.
     */
    public verifyNoOutstandingExpectation = (): void => {
        const firstOutstandingExpectation = this.expectedRequests[0];
        expect(this.expectedRequests.length).toEqual(0,
            "Expected to see HTTP request for " + firstOutstandingExpectation?.path,
        );
    }

    /**
     * Create an expected request.
     * @param {string} method The HTTP method
     * @param {string} path The path (which can be partial)
     * @param {Object} data The expected data.
     * @return {Request} An expected request.
     */
    public when = (method: HttpMethod, path: string, data?: Record<string, string>): ExpectedRequest => {
        const pendingReq = new ExpectedRequest(method, path, data);
        this.expectedRequests.push(pendingReq);
        return pendingReq;
    }

    /**
     * @return {Promise} resolves once all pending flushes are complete.
     */
    public stop = (): Promise<unknown[]> => {
        return Promise.all(this._flushPromises);
    }
};

type RequestCheckFunction = (request: Request) => void;

/**
 * Represents the expectation of a request.
 *
 * <p>Includes the conditions to be matched against, the checks to be made,
 * and the response to be returned.
 *
 * @constructor
 * @param {string} method
 * @param {string} path
 * @param {object?} data
 */
class ExpectedRequest {
    public response: unknown = null;
    public checks: RequestCheckFunction[] = [];
    constructor(
        public readonly method: HttpMethod,
        public readonly path: string,
        public readonly data?: Record<string, string>) {
    }

    public toString = (): string => {
        return this.method + " " + this.path
    }

    /**
     * Execute a check when this request has been satisfied.
     * @param {Function} fn The function to execute.
     * @return {Request} for chaining calls.
     */
    public check = (fn: RequestCheckFunction): ExpectedRequest => {
        this.checks.push(fn);
        return this;
    };

    /**
     * Respond with the given data when this request is satisfied.
     * @param {Number} code The HTTP status code.
     * @param {Object|Function?} data The response body object. If this is a function,
     * it will be invoked when the response body is required (which should be returned).
     * @param {Boolean} rawBody true if the response should be returned directly rather
     * than json-stringifying it first.
     */
    public respond = <T = Record<string, unknown>>(
        code: number, data?: T | ((...props: any[]) => T),
        rawBody?: boolean
    ): void => {
        this.response = {
            response: {
                statusCode: code,
                headers: {
                    'content-type': 'application/json',
                },
            },
            body: data || "",
            err: null,
            rawBody: rawBody || false,
        };
    }

    /**
     * Fail with an Error when this request is satisfied.
     * @param {Number} code The HTTP status code.
     * @param {Error} err The error to throw (e.g. Network Error)
     */
    public fail = (code: number, err: Error) => {
        this.response = {
            response: {
                statusCode: code,
                headers: {},
            },
            body: null,
            err: err,
        };
    }
};

/**
 * Represents a request made by the app.
 *
 * @constructor
 * @param {object} opts opts passed to request()
 * @param {function} callback
 */
class Request {
    constructor (private readonly opts: RequestOpts, public readonly callback: Callback) {}

    public get method(): HttpMethod {
        return this.opts.method;
    }

    public get path(): string {
        return this.opts.uri;
    }

    public get data(): string {
        return this.opts.body ? JSON.parse(this.opts.body) : this.opts.body;
    }

    public get rawData(): string {
        return this.opts.body;
    }

    public get queryParams(): Record<string, string> | undefined {
        return this.opts.qs;
    }

    public get  headers(): Record<string, string> {
        return this.opts.headers || {};
    }

    public toString(): string {
        return this.method + " " + this.path;
    }
}

/**
 * The HttpBackend class.
 */
export default HttpBackend;
