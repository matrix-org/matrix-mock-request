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

import Promise from 'bluebird';
import expect from 'expect';

/**
 * Construct a mock HTTP backend, heavily inspired by Angular.js.
 * @constructor
 */
function HttpBackend() {
    this.requests = [];
    this.expectedRequests = [];
    const self = this;

    // All the promises our flush requests have returned. When all these promises are
    // resolved or rejected, there are no more flushes in progress.
    // For simplicity we never remove promises from this loop: this is a mock utility
    // for short duration tests, so this keeps it simpler.
    this._flushPromises = [];

    // the request function dependency that the SDK needs.
    this.requestFn = function(opts, callback) {
        const req = new Request(opts, callback);
        console.log(`${Date.now()} HTTP backend received request: ${req}`);
        self.requests.push(req);

        const abort = function() {
            const idx = self.requests.indexOf(req);
            if (idx >= 0) {
                console.log("Aborting HTTP request: %s %s", opts.method,
                            opts.uri);
                self.requests.splice(idx, 1);
                req.callback("aborted");
            }
        };

        return {
            abort: abort,
        };
    };

    // very simplistic mapping from the whatwg fetch interface onto the request
    // interface, so we can use the same mock backend for both.
    this.fetchFn = function(input, init) {
        init = init || {};
        const requestOpts = {
            uri: input,
            method: init.method || 'GET',
            body: init.body,
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
            self.requests.push(req);
        });
    };
}
HttpBackend.prototype = {
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
    flush: function(path, numToFlush, waitTime) {
        const defer = Promise.defer();
        const self = this;
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
        const endTime =  waitTime + Date.now();

        this._flushPromises.push(defer.promise);

        const tryFlush = function() {
            try {
                _tryFlush();
            } catch (e) {
                defer.reject(e);
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
                    defer.resolve(flushed);
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
                defer.resolve(flushed);
            }
        };

        setTimeout(tryFlush, 0);

        return defer.promise;
    },

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
    flushAllExpected: function(opts) {
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

        const prom = new Promise((resolve, reject) => {
            iterate().then(() => {
                resolve(flushed);
            }, (e) => {
                reject(e);
            });
        });
        this._flushPromises.push(prom);
        return prom;
    },


    /**
     * Attempts to resolve requests/expected requests.
     * @param {string} path The path to flush (optional) default: all.
     * @return {boolean} true if something was resolved.
     */
    _takeFromQueue: function(path) {
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
                    body = body(req.path, req.data);
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
    },

    /**
     * Makes sure that the SDK hasn't sent any more requests to the backend.
     */
    verifyNoOutstandingRequests: function() {
        const firstOutstandingReq = this.requests[0] || {};
        expect(this.requests.length).toEqual(0,
            "Expected no more HTTP requests but received request to " +
            firstOutstandingReq.path,
        );
    },

    /**
     * Makes sure that the test doesn't have any unresolved requests.
     */
    verifyNoOutstandingExpectation: function() {
        const firstOutstandingExpectation = this.expectedRequests[0] || {};
        expect(this.expectedRequests.length).toEqual(0,
            "Expected to see HTTP request for " + firstOutstandingExpectation.path,
        );
    },

    /**
     * Create an expected request.
     * @param {string} method The HTTP method
     * @param {string} path The path (which can be partial)
     * @param {Object} data The expected data.
     * @return {Request} An expected request.
     */
    when: function(method, path, data) {
        const pendingReq = new ExpectedRequest(method, path, data);
        this.expectedRequests.push(pendingReq);
        return pendingReq;
    },

    /**
     * @return {Promise} resolves once all pending flushes are complete.
     */
    stop: function() {
        return Promise.all(this._flushPromises);
    },
};

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
function ExpectedRequest(method, path, data) {
    this.method = method;
    this.path = path;
    this.data = data;
    this.response = null;
    this.checks = [];
}

ExpectedRequest.prototype = {
    toString: function() {
        return this.method + " " + this.path
    },

    /**
     * Execute a check when this request has been satisfied.
     * @param {Function} fn The function to execute.
     * @return {Request} for chaining calls.
     */
    check: function(fn) {
        this.checks.push(fn);
        return this;
    },

    /**
     * Respond with the given data when this request is satisfied.
     * @param {Number} code The HTTP status code.
     * @param {Object|Function?} data The response body object. If this is a function,
     * it will be invoked when the response body is required (which should be returned).
     * @param {Boolean} rawBody true if the response should be returned directly rather
     * than json-stringifying it first.
     */
    respond: function(code, data, rawBody) {
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
    },

    /**
     * Fail with an Error when this request is satisfied.
     * @param {Number} code The HTTP status code.
     * @param {Error} err The error to throw (e.g. Network Error)
     */
    fail: function(code, err) {
        this.response = {
            response: {
                statusCode: code,
                headers: {},
            },
            body: null,
            err: err,
        };
    },
};

/**
 * Represents a request made by the app.
 *
 * @constructor
 * @param {object} opts opts passed to request()
 * @param {function} callback
 */
function Request(opts, callback) {
    this.opts = opts;
    this.callback = callback;

    Object.defineProperty(this, 'method', {
        get: function() {
            return opts.method;
        },
    });

    Object.defineProperty(this, 'path', {
        get: function() {
            return opts.uri;
        },
    });

    /**
     * Parse the body of the request as a JSON object and return it.
     */
    Object.defineProperty(this, 'data', {
        get: function() {
            return opts.body ? JSON.parse(opts.body) : opts.body;
        },
    });

    /**
     * Return the raw body passed to request
     */
    Object.defineProperty(this, 'rawData', {
        get: function() {
            return opts.body;
        },
    });

    Object.defineProperty(this, 'queryParams', {
        get: function() {
            return opts.qs;
        },
    });

    Object.defineProperty(this, 'headers', {
        get: function() {
            return opts.headers || {};
        },
    });
}

Request.prototype = {
    toString: function() {
        return this.method + " " + this.path;
    },
};

/**
 * The HttpBackend class.
 */
module.exports = HttpBackend;
