"use strict";
const require$$3$1 = require("electron");
const path = require("node:path");
const require$$0$1 = require("path");
const require$$1$1 = require("child_process");
const require$$0 = require("tty");
const require$$1 = require("util");
const require$$3 = require("fs");
const require$$4 = require("net");
const Database = require("better-sqlite3");
const fs = require("node:fs");
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var src = { exports: {} };
var browser = { exports: {} };
var debug = { exports: {} };
var ms;
var hasRequiredMs;
function requireMs() {
  if (hasRequiredMs) return ms;
  hasRequiredMs = 1;
  var s = 1e3;
  var m = s * 60;
  var h = m * 60;
  var d = h * 24;
  var y = d * 365.25;
  ms = function(val, options) {
    options = options || {};
    var type = typeof val;
    if (type === "string" && val.length > 0) {
      return parse(val);
    } else if (type === "number" && isNaN(val) === false) {
      return options.long ? fmtLong(val) : fmtShort(val);
    }
    throw new Error(
      "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
    );
  };
  function parse(str) {
    str = String(str);
    if (str.length > 100) {
      return;
    }
    var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
      str
    );
    if (!match) {
      return;
    }
    var n = parseFloat(match[1]);
    var type = (match[2] || "ms").toLowerCase();
    switch (type) {
      case "years":
      case "year":
      case "yrs":
      case "yr":
      case "y":
        return n * y;
      case "days":
      case "day":
      case "d":
        return n * d;
      case "hours":
      case "hour":
      case "hrs":
      case "hr":
      case "h":
        return n * h;
      case "minutes":
      case "minute":
      case "mins":
      case "min":
      case "m":
        return n * m;
      case "seconds":
      case "second":
      case "secs":
      case "sec":
      case "s":
        return n * s;
      case "milliseconds":
      case "millisecond":
      case "msecs":
      case "msec":
      case "ms":
        return n;
      default:
        return void 0;
    }
  }
  function fmtShort(ms2) {
    if (ms2 >= d) {
      return Math.round(ms2 / d) + "d";
    }
    if (ms2 >= h) {
      return Math.round(ms2 / h) + "h";
    }
    if (ms2 >= m) {
      return Math.round(ms2 / m) + "m";
    }
    if (ms2 >= s) {
      return Math.round(ms2 / s) + "s";
    }
    return ms2 + "ms";
  }
  function fmtLong(ms2) {
    return plural(ms2, d, "day") || plural(ms2, h, "hour") || plural(ms2, m, "minute") || plural(ms2, s, "second") || ms2 + " ms";
  }
  function plural(ms2, n, name) {
    if (ms2 < n) {
      return;
    }
    if (ms2 < n * 1.5) {
      return Math.floor(ms2 / n) + " " + name;
    }
    return Math.ceil(ms2 / n) + " " + name + "s";
  }
  return ms;
}
var hasRequiredDebug;
function requireDebug() {
  if (hasRequiredDebug) return debug.exports;
  hasRequiredDebug = 1;
  (function(module, exports$1) {
    exports$1 = module.exports = createDebug.debug = createDebug["default"] = createDebug;
    exports$1.coerce = coerce;
    exports$1.disable = disable;
    exports$1.enable = enable;
    exports$1.enabled = enabled;
    exports$1.humanize = requireMs();
    exports$1.names = [];
    exports$1.skips = [];
    exports$1.formatters = {};
    var prevTime;
    function selectColor(namespace) {
      var hash = 0, i;
      for (i in namespace) {
        hash = (hash << 5) - hash + namespace.charCodeAt(i);
        hash |= 0;
      }
      return exports$1.colors[Math.abs(hash) % exports$1.colors.length];
    }
    function createDebug(namespace) {
      function debug2() {
        if (!debug2.enabled) return;
        var self = debug2;
        var curr = +/* @__PURE__ */ new Date();
        var ms2 = curr - (prevTime || curr);
        self.diff = ms2;
        self.prev = prevTime;
        self.curr = curr;
        prevTime = curr;
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; i++) {
          args[i] = arguments[i];
        }
        args[0] = exports$1.coerce(args[0]);
        if ("string" !== typeof args[0]) {
          args.unshift("%O");
        }
        var index = 0;
        args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
          if (match === "%%") return match;
          index++;
          var formatter = exports$1.formatters[format];
          if ("function" === typeof formatter) {
            var val = args[index];
            match = formatter.call(self, val);
            args.splice(index, 1);
            index--;
          }
          return match;
        });
        exports$1.formatArgs.call(self, args);
        var logFn = debug2.log || exports$1.log || console.log.bind(console);
        logFn.apply(self, args);
      }
      debug2.namespace = namespace;
      debug2.enabled = exports$1.enabled(namespace);
      debug2.useColors = exports$1.useColors();
      debug2.color = selectColor(namespace);
      if ("function" === typeof exports$1.init) {
        exports$1.init(debug2);
      }
      return debug2;
    }
    function enable(namespaces) {
      exports$1.save(namespaces);
      exports$1.names = [];
      exports$1.skips = [];
      var split = (typeof namespaces === "string" ? namespaces : "").split(/[\s,]+/);
      var len = split.length;
      for (var i = 0; i < len; i++) {
        if (!split[i]) continue;
        namespaces = split[i].replace(/\*/g, ".*?");
        if (namespaces[0] === "-") {
          exports$1.skips.push(new RegExp("^" + namespaces.substr(1) + "$"));
        } else {
          exports$1.names.push(new RegExp("^" + namespaces + "$"));
        }
      }
    }
    function disable() {
      exports$1.enable("");
    }
    function enabled(name) {
      var i, len;
      for (i = 0, len = exports$1.skips.length; i < len; i++) {
        if (exports$1.skips[i].test(name)) {
          return false;
        }
      }
      for (i = 0, len = exports$1.names.length; i < len; i++) {
        if (exports$1.names[i].test(name)) {
          return true;
        }
      }
      return false;
    }
    function coerce(val) {
      if (val instanceof Error) return val.stack || val.message;
      return val;
    }
  })(debug, debug.exports);
  return debug.exports;
}
var hasRequiredBrowser;
function requireBrowser() {
  if (hasRequiredBrowser) return browser.exports;
  hasRequiredBrowser = 1;
  (function(module, exports$1) {
    exports$1 = module.exports = requireDebug();
    exports$1.log = log2;
    exports$1.formatArgs = formatArgs;
    exports$1.save = save;
    exports$1.load = load;
    exports$1.useColors = useColors;
    exports$1.storage = "undefined" != typeof chrome && "undefined" != typeof chrome.storage ? chrome.storage.local : localstorage();
    exports$1.colors = [
      "lightseagreen",
      "forestgreen",
      "goldenrod",
      "dodgerblue",
      "darkorchid",
      "crimson"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && window.process.type === "renderer") {
        return true;
      }
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31 || // double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    exports$1.formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (err) {
        return "[UnexpectedJSONParseError]: " + err.message;
      }
    };
    function formatArgs(args) {
      var useColors2 = this.useColors;
      args[0] = (useColors2 ? "%c" : "") + this.namespace + (useColors2 ? " %c" : " ") + args[0] + (useColors2 ? "%c " : " ") + "+" + exports$1.humanize(this.diff);
      if (!useColors2) return;
      var c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      var index = 0;
      var lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, function(match) {
        if ("%%" === match) return;
        index++;
        if ("%c" === match) {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    function log2() {
      return "object" === typeof console && console.log && Function.prototype.apply.call(console.log, console, arguments);
    }
    function save(namespaces) {
      try {
        if (null == namespaces) {
          exports$1.storage.removeItem("debug");
        } else {
          exports$1.storage.debug = namespaces;
        }
      } catch (e) {
      }
    }
    function load() {
      var r;
      try {
        r = exports$1.storage.debug;
      } catch (e) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    exports$1.enable(load());
    function localstorage() {
      try {
        return window.localStorage;
      } catch (e) {
      }
    }
  })(browser, browser.exports);
  return browser.exports;
}
var node = { exports: {} };
var hasRequiredNode;
function requireNode() {
  if (hasRequiredNode) return node.exports;
  hasRequiredNode = 1;
  (function(module, exports$1) {
    var tty = require$$0;
    var util = require$$1;
    exports$1 = module.exports = requireDebug();
    exports$1.init = init;
    exports$1.log = log2;
    exports$1.formatArgs = formatArgs;
    exports$1.save = save;
    exports$1.load = load;
    exports$1.useColors = useColors;
    exports$1.colors = [6, 2, 3, 4, 5, 1];
    exports$1.inspectOpts = Object.keys(process.env).filter(function(key) {
      return /^debug_/i.test(key);
    }).reduce(function(obj, key) {
      var prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, function(_, k) {
        return k.toUpperCase();
      });
      var val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) val = true;
      else if (/^(no|off|false|disabled)$/i.test(val)) val = false;
      else if (val === "null") val = null;
      else val = Number(val);
      obj[prop] = val;
      return obj;
    }, {});
    var fd = parseInt(process.env.DEBUG_FD, 10) || 2;
    if (1 !== fd && 2 !== fd) {
      util.deprecate(function() {
      }, "except for stderr(2) and stdout(1), any other usage of DEBUG_FD is deprecated. Override debug.log if you want to use a different log function (https://git.io/debug_fd)")();
    }
    var stream = 1 === fd ? process.stdout : 2 === fd ? process.stderr : createWritableStdioStream(fd);
    function useColors() {
      return "colors" in exports$1.inspectOpts ? Boolean(exports$1.inspectOpts.colors) : tty.isatty(fd);
    }
    exports$1.formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map(function(str) {
        return str.trim();
      }).join(" ");
    };
    exports$1.formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
    function formatArgs(args) {
      var name = this.namespace;
      var useColors2 = this.useColors;
      if (useColors2) {
        var c = this.color;
        var prefix = "  \x1B[3" + c + ";1m" + name + " \x1B[0m";
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push("\x1B[3" + c + "m+" + exports$1.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = (/* @__PURE__ */ new Date()).toUTCString() + " " + name + " " + args[0];
      }
    }
    function log2() {
      return stream.write(util.format.apply(util, arguments) + "\n");
    }
    function save(namespaces) {
      if (null == namespaces) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = namespaces;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function createWritableStdioStream(fd2) {
      var stream2;
      var tty_wrap = process.binding("tty_wrap");
      switch (tty_wrap.guessHandleType(fd2)) {
        case "TTY":
          stream2 = new tty.WriteStream(fd2);
          stream2._type = "tty";
          if (stream2._handle && stream2._handle.unref) {
            stream2._handle.unref();
          }
          break;
        case "FILE":
          var fs2 = require$$3;
          stream2 = new fs2.SyncWriteStream(fd2, { autoClose: false });
          stream2._type = "fs";
          break;
        case "PIPE":
        case "TCP":
          var net = require$$4;
          stream2 = new net.Socket({
            fd: fd2,
            readable: false,
            writable: true
          });
          stream2.readable = false;
          stream2.read = null;
          stream2._type = "pipe";
          if (stream2._handle && stream2._handle.unref) {
            stream2._handle.unref();
          }
          break;
        default:
          throw new Error("Implement me. Unknown stream file type!");
      }
      stream2.fd = fd2;
      stream2._isStdio = true;
      return stream2;
    }
    function init(debug2) {
      debug2.inspectOpts = {};
      var keys = Object.keys(exports$1.inspectOpts);
      for (var i = 0; i < keys.length; i++) {
        debug2.inspectOpts[keys[i]] = exports$1.inspectOpts[keys[i]];
      }
    }
    exports$1.enable(load());
  })(node, node.exports);
  return node.exports;
}
var hasRequiredSrc;
function requireSrc() {
  if (hasRequiredSrc) return src.exports;
  hasRequiredSrc = 1;
  if (typeof process !== "undefined" && process.type === "renderer") {
    src.exports = requireBrowser();
  } else {
    src.exports = requireNode();
  }
  return src.exports;
}
var electronSquirrelStartup;
var hasRequiredElectronSquirrelStartup;
function requireElectronSquirrelStartup() {
  if (hasRequiredElectronSquirrelStartup) return electronSquirrelStartup;
  hasRequiredElectronSquirrelStartup = 1;
  var path2 = require$$0$1;
  var spawn = require$$1$1.spawn;
  var debug2 = requireSrc()("electron-squirrel-startup");
  var app = require$$3$1.app;
  var run = function(args, done) {
    var updateExe = path2.resolve(path2.dirname(process.execPath), "..", "Update.exe");
    debug2("Spawning `%s` with args `%s`", updateExe, args);
    spawn(updateExe, args, {
      detached: true
    }).on("close", done);
  };
  var check = function() {
    if (process.platform === "win32") {
      var cmd = process.argv[1];
      debug2("processing squirrel command `%s`", cmd);
      var target = path2.basename(process.execPath);
      if (cmd === "--squirrel-install" || cmd === "--squirrel-updated") {
        run(["--createShortcut=" + target], app.quit);
        return true;
      }
      if (cmd === "--squirrel-uninstall") {
        run(["--removeShortcut=" + target], app.quit);
        return true;
      }
      if (cmd === "--squirrel-obsolete") {
        app.quit();
        return true;
      }
    }
    return false;
  };
  electronSquirrelStartup = check();
  return electronSquirrelStartup;
}
var electronSquirrelStartupExports = requireElectronSquirrelStartup();
const started = /* @__PURE__ */ getDefaultExportFromCjs(electronSquirrelStartupExports);
var loglevel$1 = { exports: {} };
var loglevel = loglevel$1.exports;
var hasRequiredLoglevel;
function requireLoglevel() {
  if (hasRequiredLoglevel) return loglevel$1.exports;
  hasRequiredLoglevel = 1;
  (function(module) {
    (function(root, definition) {
      if (module.exports) {
        module.exports = definition();
      } else {
        root.log = definition();
      }
    })(loglevel, function() {
      var noop = function() {
      };
      var undefinedType = "undefined";
      var isIE = typeof window !== undefinedType && typeof window.navigator !== undefinedType && /Trident\/|MSIE /.test(window.navigator.userAgent);
      var logMethods = [
        "trace",
        "debug",
        "info",
        "warn",
        "error"
      ];
      var _loggersByName = {};
      var defaultLogger = null;
      function bindMethod(obj, methodName) {
        var method = obj[methodName];
        if (typeof method.bind === "function") {
          return method.bind(obj);
        } else {
          try {
            return Function.prototype.bind.call(method, obj);
          } catch (e) {
            return function() {
              return Function.prototype.apply.apply(method, [obj, arguments]);
            };
          }
        }
      }
      function traceForIE() {
        if (console.log) {
          if (console.log.apply) {
            console.log.apply(console, arguments);
          } else {
            Function.prototype.apply.apply(console.log, [console, arguments]);
          }
        }
        if (console.trace) console.trace();
      }
      function realMethod(methodName) {
        if (methodName === "debug") {
          methodName = "log";
        }
        if (typeof console === undefinedType) {
          return false;
        } else if (methodName === "trace" && isIE) {
          return traceForIE;
        } else if (console[methodName] !== void 0) {
          return bindMethod(console, methodName);
        } else if (console.log !== void 0) {
          return bindMethod(console, "log");
        } else {
          return noop;
        }
      }
      function replaceLoggingMethods() {
        var level = this.getLevel();
        for (var i = 0; i < logMethods.length; i++) {
          var methodName = logMethods[i];
          this[methodName] = i < level ? noop : this.methodFactory(methodName, level, this.name);
        }
        this.log = this.debug;
        if (typeof console === undefinedType && level < this.levels.SILENT) {
          return "No console available for logging";
        }
      }
      function enableLoggingWhenConsoleArrives(methodName) {
        return function() {
          if (typeof console !== undefinedType) {
            replaceLoggingMethods.call(this);
            this[methodName].apply(this, arguments);
          }
        };
      }
      function defaultMethodFactory(methodName, _level, _loggerName) {
        return realMethod(methodName) || enableLoggingWhenConsoleArrives.apply(this, arguments);
      }
      function Logger(name, factory) {
        var self = this;
        var inheritedLevel;
        var defaultLevel;
        var userLevel;
        var storageKey = "loglevel";
        if (typeof name === "string") {
          storageKey += ":" + name;
        } else if (typeof name === "symbol") {
          storageKey = void 0;
        }
        function persistLevelIfPossible(levelNum) {
          var levelName = (logMethods[levelNum] || "silent").toUpperCase();
          if (typeof window === undefinedType || !storageKey) return;
          try {
            window.localStorage[storageKey] = levelName;
            return;
          } catch (ignore) {
          }
          try {
            window.document.cookie = encodeURIComponent(storageKey) + "=" + levelName + ";";
          } catch (ignore) {
          }
        }
        function getPersistedLevel() {
          var storedLevel;
          if (typeof window === undefinedType || !storageKey) return;
          try {
            storedLevel = window.localStorage[storageKey];
          } catch (ignore) {
          }
          if (typeof storedLevel === undefinedType) {
            try {
              var cookie = window.document.cookie;
              var cookieName = encodeURIComponent(storageKey);
              var location = cookie.indexOf(cookieName + "=");
              if (location !== -1) {
                storedLevel = /^([^;]+)/.exec(
                  cookie.slice(location + cookieName.length + 1)
                )[1];
              }
            } catch (ignore) {
            }
          }
          if (self.levels[storedLevel] === void 0) {
            storedLevel = void 0;
          }
          return storedLevel;
        }
        function clearPersistedLevel() {
          if (typeof window === undefinedType || !storageKey) return;
          try {
            window.localStorage.removeItem(storageKey);
          } catch (ignore) {
          }
          try {
            window.document.cookie = encodeURIComponent(storageKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC";
          } catch (ignore) {
          }
        }
        function normalizeLevel(input) {
          var level = input;
          if (typeof level === "string" && self.levels[level.toUpperCase()] !== void 0) {
            level = self.levels[level.toUpperCase()];
          }
          if (typeof level === "number" && level >= 0 && level <= self.levels.SILENT) {
            return level;
          } else {
            throw new TypeError("log.setLevel() called with invalid level: " + input);
          }
        }
        self.name = name;
        self.levels = {
          "TRACE": 0,
          "DEBUG": 1,
          "INFO": 2,
          "WARN": 3,
          "ERROR": 4,
          "SILENT": 5
        };
        self.methodFactory = factory || defaultMethodFactory;
        self.getLevel = function() {
          if (userLevel != null) {
            return userLevel;
          } else if (defaultLevel != null) {
            return defaultLevel;
          } else {
            return inheritedLevel;
          }
        };
        self.setLevel = function(level, persist) {
          userLevel = normalizeLevel(level);
          if (persist !== false) {
            persistLevelIfPossible(userLevel);
          }
          return replaceLoggingMethods.call(self);
        };
        self.setDefaultLevel = function(level) {
          defaultLevel = normalizeLevel(level);
          if (!getPersistedLevel()) {
            self.setLevel(level, false);
          }
        };
        self.resetLevel = function() {
          userLevel = null;
          clearPersistedLevel();
          replaceLoggingMethods.call(self);
        };
        self.enableAll = function(persist) {
          self.setLevel(self.levels.TRACE, persist);
        };
        self.disableAll = function(persist) {
          self.setLevel(self.levels.SILENT, persist);
        };
        self.rebuild = function() {
          if (defaultLogger !== self) {
            inheritedLevel = normalizeLevel(defaultLogger.getLevel());
          }
          replaceLoggingMethods.call(self);
          if (defaultLogger === self) {
            for (var childName in _loggersByName) {
              _loggersByName[childName].rebuild();
            }
          }
        };
        inheritedLevel = normalizeLevel(
          defaultLogger ? defaultLogger.getLevel() : "WARN"
        );
        var initialLevel = getPersistedLevel();
        if (initialLevel != null) {
          userLevel = normalizeLevel(initialLevel);
        }
        replaceLoggingMethods.call(self);
      }
      defaultLogger = new Logger();
      defaultLogger.getLogger = function getLogger(name) {
        if (typeof name !== "symbol" && typeof name !== "string" || name === "") {
          throw new TypeError("You must supply a name when creating a logger.");
        }
        var logger = _loggersByName[name];
        if (!logger) {
          logger = _loggersByName[name] = new Logger(
            name,
            defaultLogger.methodFactory
          );
        }
        return logger;
      };
      var _log = typeof window !== undefinedType ? window.log : void 0;
      defaultLogger.noConflict = function() {
        if (typeof window !== undefinedType && window.log === defaultLogger) {
          window.log = _log;
        }
        return defaultLogger;
      };
      defaultLogger.getLoggers = function getLoggers() {
        return _loggersByName;
      };
      defaultLogger["default"] = defaultLogger;
      return defaultLogger;
    });
  })(loglevel$1);
  return loglevel$1.exports;
}
var loglevelExports = requireLoglevel();
const log = /* @__PURE__ */ getDefaultExportFromCjs(loglevelExports);
log.setLevel(log.levels.ERROR);
let db = null;
function getDbDirectory() {
  const userDataPath = require$$3$1.app.getPath("userData");
  const dbDir = path.join(userDataPath, "databases");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return dbDir;
}
function initDatabase(dbName) {
  try {
    if (db) {
      db.close();
      db = null;
    }
    const dbDir = getDbDirectory();
    const dbPath = path.join(dbDir, dbName);
    log.info(`[Database] Opening database: ${dbPath}`);
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    runMigrations();
    log.info("[Database] Database initialized successfully");
  } catch (error) {
    log.error("[Database] Failed to initialize database:", error);
    throw error;
  }
}
function runMigrations() {
  if (!db) return;
  db.exec(`
-- =============================
-- Book Element / Element Schema
-- =============================
-- Projects table
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  project_name TEXT,
  author TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_name ON project(project_name);

-- Category table (element categories)
CREATE TABLE IF NOT EXISTS element_category (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  color TEXT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

-- Story stages (higher level than nodes/chapters)
CREATE TABLE IF NOT EXISTS story_stage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  order_key INTEGER NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_stage_project ON story_stage(project_id);
CREATE INDEX IF NOT EXISTS idx_story_stage_order ON story_stage(project_id, order_key);

-- Node tags (user-defined tags for categorizing nodes)
CREATE TABLE IF NOT EXISTS node_tag (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_node_tag_project ON node_tag(project_id);

-- Node-tag link (many-to-many)
CREATE TABLE IF NOT EXISTS node_tag_link (
  node_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(node_id, tag_id),
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES node_tag(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_node_tag_link_node ON node_tag_link(node_id);
CREATE INDEX IF NOT EXISTS idx_node_tag_link_tag ON node_tag_link(tag_id);

-- Story nodes (chapters/nodes - basic writing units)
CREATE TABLE IF NOT EXISTS story_node (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER,
  summary TEXT,
  story_stage_id TEXT,
  pos_x REAL,
  pos_y REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY(story_stage_id) REFERENCES story_stage(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_story_node_project ON story_node(project_id);
CREATE INDEX IF NOT EXISTS idx_story_node_stage ON story_node(story_stage_id);
CREATE INDEX IF NOT EXISTS idx_story_node_timeline ON story_node(project_id, start, end);
CREATE INDEX IF NOT EXISTS idx_story_node_sync ON story_node(sync_status) WHERE is_deleted = 0;

-- Storylines (narrative threads/storylines)
CREATE TABLE IF NOT EXISTS storyline (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  summary TEXT,
  pm_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_storyline_project ON storyline(project_id);
CREATE INDEX IF NOT EXISTS idx_storyline_sync ON storyline(sync_status) WHERE is_deleted = 0;

-- Node to storyline relationship (many-to-many)
CREATE TABLE IF NOT EXISTS node_storyline (
  node_id TEXT NOT NULL,
  storyline_id TEXT NOT NULL,
  storyline_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(node_id, storyline_id),
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(storyline_id) REFERENCES storyline(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_node_storyline_node ON node_storyline(node_id);
CREATE INDEX IF NOT EXISTS idx_node_storyline_storyline ON node_storyline(storyline_id);

-- Edges between nodes 
CREATE TABLE IF NOT EXISTS node_edge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  src_node_id TEXT NOT NULL,
  dst_node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  style TEXT,  -- JSON for style props
  data TEXT,   -- JSON for freeform geometry (control points, anchors)
  created_at TEXT NOT NULL, 
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_node_edge_project ON node_edge(project_id);
CREATE INDEX IF NOT EXISTS idx_node_edge_src ON node_edge(src_node_id);
CREATE INDEX IF NOT EXISTS idx_node_edge_dst ON node_edge(dst_node_id);



-- Book content table

-- Book content table 
CREATE TABLE IF NOT EXISTS book_content (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  pm_json TEXT NOT NULL DEFAULT '{}',
  outline_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_content_node ON book_content(node_id);
CREATE INDEX IF NOT EXISTS idx_book_content_sync ON book_content(sync_status) WHERE is_deleted = 0;

-- Core element (element) table
CREATE TABLE IF NOT EXISTS element (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(category_id) REFERENCES element_category(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_element_project ON element(project_id);
CREATE INDEX IF NOT EXISTS idx_element_category ON element(category_id);
CREATE INDEX IF NOT EXISTS idx_element_sync ON element(sync_status) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_element_type ON element(type);

-- Element tags
CREATE TABLE IF NOT EXISTS element_tag (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(element_id, name)
);
CREATE INDEX IF NOT EXISTS idx_element_tag_element ON element_tag(element_id);
CREATE INDEX IF NOT EXISTS idx_element_tag_name ON element_tag(name);

-- Element stages (evolution across the story)
CREATE TABLE IF NOT EXISTS element_stage (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  start_node_id TEXT,
  end_node_id TEXT,
  name TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(element_id, stage_index)
);
CREATE INDEX IF NOT EXISTS idx_element_stage_element ON element_stage(element_id);
CREATE INDEX IF NOT EXISTS idx_element_stage_stage_index ON element_stage(element_id, stage_index);

-- Element to story node links (many-to-many)
CREATE TABLE IF NOT EXISTS element_node_link (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(node_id, element_id)
);
CREATE INDEX IF NOT EXISTS idx_element_node_link_node ON element_node_link(node_id);
CREATE INDEX IF NOT EXISTS idx_element_node_link_element ON element_node_link(element_id);

-- Mapping stages to chapters (span coverage)
CREATE TABLE IF NOT EXISTS chapter_element_stage (
  chapter_id TEXT NOT NULL,
  element_stage_id TEXT NOT NULL,
  PRIMARY KEY(chapter_id, element_stage_id),
  FOREIGN KEY(element_stage_id) REFERENCES element_stage(id) ON DELETE CASCADE
);

-- Element occurrence inside text blocks (for auto-linking)
CREATE TABLE IF NOT EXISTS element_occurrence (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  spans_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_element ON element_occurrence(element_id);
CREATE INDEX IF NOT EXISTS idx_element_occurrence_node ON element_occurrence(node_id);
  `);
  try {
    db.prepare("ALTER TABLE node_edge ADD COLUMN style TEXT").run();
  } catch (e) {
  }
  try {
    db.prepare("ALTER TABLE node_edge ADD COLUMN data TEXT").run();
  } catch (e) {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const defaultProject = db.prepare("SELECT id FROM project WHERE id = ?").get("default-project");
  if (!defaultProject) {
    log.info("[Database] Creating default project");
    db.prepare(`
      INSERT INTO project (id, project_name, author, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "default-project",
      "Default Project",
      "Author Name",
      "This is your default project. You can create more projects later.",
      now,
      now
    );
  }
  const defaultCategory = db.prepare("SELECT id FROM element_category WHERE id = ?").get("cat_default");
  if (!defaultCategory) {
    log.info("[Database] Creating default element category");
    db.prepare(`
      INSERT INTO element_category (id, name, description_json, color, sync_status, last_modified, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "cat_default",
      "others",
      JSON.stringify({ description: "Default category" }),
      "#CCCCCC",
      "synced",
      Date.now(),
      0
    );
  }
  const defaultStoryline = db.prepare("SELECT id FROM storyline WHERE id = ?").get("storyline_main");
  if (!defaultStoryline) {
    log.info("[Database] Creating default storyline");
    db.prepare(`
      INSERT INTO storyline (id, project_id, name, color, summary, created_at, updated_at, sync_status, last_modified, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "storyline_main",
      "default-project",
      "Main Story",
      "#3B82F6",
      "Main storyline",
      now,
      now,
      "synced",
      Date.now(),
      0
    );
  }
}
function setupDatabase() {
  require$$3$1.ipcMain.handle("db:init", async (_event, dbName) => {
    initDatabase(dbName);
  });
  require$$3$1.ipcMain.handle("db:run", async (_event, sql, params) => {
    if (!db) throw new Error("Database not initialized");
    try {
      const stmt = db.prepare(sql);
      const result = stmt.run(...params || []);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid
      };
    } catch (error) {
      log.error("[Database] Run error:", error);
      throw error;
    }
  });
  require$$3$1.ipcMain.handle("db:query", async (_event, sql, params) => {
    if (!db) throw new Error("Database not initialized");
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...params || []);
    } catch (error) {
      log.error("[Database] Query error:", error);
      throw error;
    }
  });
  require$$3$1.ipcMain.handle("db:get", async (_event, sql, params) => {
    if (!db) throw new Error("Database not initialized");
    try {
      const stmt = db.prepare(sql);
      return stmt.get(...params || []);
    } catch (error) {
      log.error("[Database] Get error:", error);
      throw error;
    }
  });
  require$$3$1.ipcMain.handle("db:close", async () => {
    if (db) {
      db.close();
      db = null;
    }
  });
}
if (started) {
  require$$3$1.app.quit();
}
let mainWindow = null;
const createWindow = () => {
  mainWindow = new require$$3$1.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1e3,
    minHeight: 700,
    title: "Drifting",
    // 自定义窗口栏配置
    titleBarStyle: "hiddenInset",
    // macOS: 隐藏标题栏但保留交通灯按钮
    // titleBarStyle: 'hidden', // 完全隐藏标题栏（包括交通灯）
    trafficLightPosition: { x: 12, y: 12 },
    // macOS 交通灯按钮位置
    frame: process.platform !== "darwin",
    // 非 macOS 显示边框
    // frame: false, // 如果要在所有平台完全无边框，取消注释这行
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    show: false
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};
require$$3$1.app.whenReady().then(async () => {
  setupDatabase();
  createWindow();
  require$$3$1.app.on("activate", () => {
    if (require$$3$1.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
require$$3$1.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    require$$3$1.app.quit();
  }
});
require$$3$1.ipcMain.handle("app:getVersion", () => {
  return require$$3$1.app.getVersion();
});
require$$3$1.ipcMain.handle("app:getPath", (_event, name) => {
  return require$$3$1.app.getPath(name);
});
require$$3$1.ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});
require$$3$1.ipcMain.handle("window:toggleMaximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow?.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
require$$3$1.ipcMain.handle("window:close", () => {
  mainWindow?.close();
});
require$$3$1.ipcMain.handle("window:isMaximized", () => {
  return mainWindow?.isMaximized() ?? false;
});
const gotTheLock = require$$3$1.app.requestSingleInstanceLock();
if (!gotTheLock) {
  require$$3$1.app.quit();
} else {
  require$$3$1.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
