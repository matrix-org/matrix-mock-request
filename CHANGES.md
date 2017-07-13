## next version

 - Give a sensible rejection from `flushAllExpected` when there are no
   expectations (previously it would throw an obscure exception)
 
## 1.1.0

 - Add `flushAllExpected`.
 - Wait for longer in `flush` when a `numToFlush` is specified.
 - Try to avoid throwing exceptions from `setTimeout` (and reject the returned
   promise instead).
 - Switch to bluebird instead of q.

## 1.0.0

 - Changes required for https://github.com/matrix-org/matrix-js-sdk/pull/479:
   js-sdk now does its own JSON encoding/parsing, so in order to keep the tests
   working we need to reverse that process.

## 0.1.3

 - Fix missing /lib in published package.
 
## 0.1.2

 - Transpile for ES5.

## 0.1.1

 - Import changes from riot-web.

## 0.1.0

 - Initial release, factored out from matrix-js-sdk.
