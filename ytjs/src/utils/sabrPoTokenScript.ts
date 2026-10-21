/*
 * Port of PipePipe's `sabr_po_token.js` (PipePipeClient/app/src/main/assets).
 *
 * Differences from the asset, all forced by the runtime change:
 *
 *  - The Android WebView bridge (PipePipeWebViewBridge) is gone. Each entry
 *    point returns a Promise instead of calling back into the app, so Node can
 *    simply `await page.evaluate(...)`.
 *  - The CSV-encoded `poTokenU8` bridge serialization is gone; obtainPoToken
 *    returns a plain number[] (Playwright cannot marshal a Uint8Array back
 *    through an isolated-world evaluate, and main-world evaluates only support
 *    it asymmetrically).
 *  - `runBotGuard` is invoked with `.call(window, ...)`: the asset relies on
 *    an Android `evaluateJavascript` calling it as a global (so `this` is the
 *    window), whereas a Playwright evaluate body does not set `this`.
 *
 * The BotGuard sequence itself is unchanged: eval'interpreter -> vm.a(program,
 * ...) -> asyncSnapshotFunction -> webPoSignalOutput -> minter(integrityToken)
 * -> minter(identifierU8).
 *
 * Exposed on the sandbox window as:
 *   pipepipeSabrRunBotguard(sessionId, eventId, challengeData)
 *   pipepipeSabrCreateMinter(sessionId, integrityToken)
 *   pipepipeSabrObtainPoToken(sessionId, identifier)
 *   pipepipeSabrDeleteSession(sessionId)
 */

export const SABR_PO_TOKEN_SCRIPT = String.raw`
(function () {
  function loadBotGuard(root, challengeData) {
    return new Promise(function (resolve, reject) {
      var intervalId;
      var finished = false;

      function fail(error) {
        if (finished) return;
        finished = true;
        if (intervalId) clearInterval(intervalId);
        reject(error);
      }

      try {
        root.vm = root[challengeData.globalName];
        root.program = challengeData.program;
        root.vmFunctions = {};
        root.syncSnapshotFunction = null;

        if (!root.vm) throw new Error("[BotGuardClient]: VM not found in the global object");
        if (!root.vm.a) throw new Error("[BotGuardClient]: Could not load program");

        var vmFunctionsCallback = function (
          asyncSnapshotFunction,
          shutdownFunction,
          passEventFunction,
          checkCameraFunction
        ) {
          root.vmFunctions = {
            asyncSnapshotFunction: asyncSnapshotFunction,
            shutdownFunction: shutdownFunction,
            passEventFunction: passEventFunction,
            checkCameraFunction: checkCameraFunction,
          };
        };

        var noOp = function () {};
        var loggerFunctions = [noOp, noOp, noOp, noOp, noOp];

        root.syncSnapshotFunction = root.vm.a(
          root.program,
          vmFunctionsCallback,
          true,
          root.userInteractionElement,
          noOp,
          [[], []],
          undefined,
          false,
          loggerFunctions
        )[0];

        root._botGuardPolls = 0;
        intervalId = setInterval(function () {
          if (root.vmFunctions.asyncSnapshotFunction) {
            finished = true;
            clearInterval(intervalId);
            resolve(root);
            return;
          }
          if (root._botGuardPolls >= 10000) {
            fail(new Error("asyncSnapshotFunction is null even after 10 seconds"));
            return;
          }
          root._botGuardPolls = (root._botGuardPolls || 0) + 1;
        }, 1);
      } catch (error) {
        fail(error);
      }
    });
  }

  function snapshot(root, args) {
    return new Promise(function (resolve, reject) {
      try {
        if (!root.vmFunctions.asyncSnapshotFunction) {
          throw new Error("[BotGuardClient]: Async snapshot function not found");
        }
        root.vmFunctions.asyncSnapshotFunction(
          function (response) { resolve(response); },
          [args.contentBinding, args.signedTimestamp, args.webPoSignalOutput, args.skipPrivacyBuffer]
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function runBotGuard(challengeData) {
    var root = this;
    var interpreterJavascript =
      challengeData.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;

    if (!interpreterJavascript) {
      return Promise.reject(new Error("Could not load VM"));
    }

    try {
      new Function(interpreterJavascript)();
    } catch (error) {
      return Promise.reject(error);
    }

    var webPoSignalOutput = [];
    return loadBotGuard(root, {
      globalName: challengeData.globalName,
      globalObj: root,
      program: challengeData.program,
    }).then(function (botguard) {
      return snapshot(botguard, { webPoSignalOutput: webPoSignalOutput }).then(function (botguardResponse) {
        return { webPoSignalOutput: webPoSignalOutput, botguardResponse: botguardResponse };
      });
    });
  }

  function createPoTokenMinter(webPoSignalOutput, integrityToken) {
    var getMinter = webPoSignalOutput[0];
    if (!getMinter) throw new Error("PMD:Undefined");
    var mintCallback = getMinter(integrityToken);
    if (!(mintCallback instanceof Function)) throw new Error("APF:Failed");
    return mintCallback;
  }

  function obtainPoToken(mintCallback, identifier) {
    var result = mintCallback(identifier);
    if (!result) throw new Error("YNJ:Undefined");
    if (!(result instanceof Uint8Array)) throw new Error("ODM:Invalid");
    return result;
  }

  window.pipepipeSabrRunBotguard = function (sessionId, eventId, challengeData) {
    window.yt = window.yt || {};
    window.yt.config_ = window.yt.config_ || {};
    if (eventId) window.yt.config_.EVENT_ID = eventId;

    return runBotGuard.call(window, challengeData).then(function (result) {
      window.__sabrLocalDomSessions = window.__sabrLocalDomSessions || {};
      window.__sabrLocalDomSessions[sessionId] = {
        webPoSignalOutput: result.webPoSignalOutput,
      };
      return result.botguardResponse;
    });
  };

  window.pipepipeSabrCreateMinter = function (sessionId, integrityToken) {
    var sessions = window.__sabrLocalDomSessions || {};
    var session = sessions[sessionId];
    if (!session || !session.webPoSignalOutput) {
      throw new Error("Local DOM WebPO signal output is missing");
    }
    session.integrityToken = integrityToken;
    session.poTokenMinter = createPoTokenMinter(session.webPoSignalOutput, session.integrityToken);
    return true;
  };

  window.pipepipeSabrObtainPoToken = function (sessionId, identifierU8) {
    var sessions = window.__sabrLocalDomSessions || {};
    var session = sessions[sessionId];
    if (!session || !session.poTokenMinter) {
      throw new Error("Local DOM PO token minter is not ready");
    }
    var poTokenU8 = obtainPoToken(session.poTokenMinter, identifierU8);
    var out = [];
    for (var i = 0; i < poTokenU8.length; i++) out.push(poTokenU8[i]);
    return out;
  };

  window.pipepipeSabrDeleteSession = function (sessionId) {
    if (window.__sabrLocalDomSessions) delete window.__sabrLocalDomSessions[sessionId];
    return true;
  };

  return true;
})()
`;
