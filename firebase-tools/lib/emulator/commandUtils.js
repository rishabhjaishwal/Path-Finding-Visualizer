"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emulatorExec = exports.shutdownWhenKilled = exports.setExportOnExitOptions = exports.parseInspectionPort = exports.beforeEmulatorCommand = exports.warnEmulatorNotSupported = exports.printNoticeIfEmulated = exports.DESC_TEST_PARAMS = exports.FLAG_TEST_PARAMS = exports.DESC_TEST_CONFIG = exports.FLAG_TEST_CONFIG = exports.DESC_UI = exports.FLAG_UI = exports.EXPORT_ON_EXIT_USAGE_ERROR = exports.DESC_EXPORT_ON_EXIT = exports.FLAG_EXPORT_ON_EXIT = exports.FLAG_EXPORT_ON_EXIT_NAME = exports.DESC_IMPORT = exports.FLAG_IMPORT = exports.DESC_INSPECT_FUNCTIONS = exports.FLAG_INSPECT_FUNCTIONS = exports.DESC_ONLY = exports.FLAG_ONLY = void 0;
const clc = require("cli-color");
const childProcess = require("child_process");
const controller = require("../emulator/controller");
const Config = require("../config");
const utils = require("../utils");
const logger = require("../logger");
const path = require("path");
const constants_1 = require("./constants");
const requireAuth_1 = require("../requireAuth");
const requireConfig = require("../requireConfig");
const types_1 = require("./types");
const error_1 = require("../error");
const registry_1 = require("./registry");
const firestoreEmulator_1 = require("./firestoreEmulator");
const getProjectId = require("../getProjectId");
const prompt_1 = require("../prompt");
const hub_1 = require("./hub");
const controller_1 = require("./controller");
const fsutils = require("../fsutils");
const Table = require("cli-table");
exports.FLAG_ONLY = "--only <emulators>";
exports.DESC_ONLY = "only specific emulators. " +
    "This is a comma separated list of emulator names. " +
    "Valid options are: " +
    JSON.stringify(types_1.ALL_SERVICE_EMULATORS);
exports.FLAG_INSPECT_FUNCTIONS = "--inspect-functions [port]";
exports.DESC_INSPECT_FUNCTIONS = "emulate Cloud Functions in debug mode with the node inspector on the given port (9229 if not specified)";
exports.FLAG_IMPORT = "--import [dir]";
exports.DESC_IMPORT = "import emulator data from a previous export (see emulators:export)";
exports.FLAG_EXPORT_ON_EXIT_NAME = "--export-on-exit";
exports.FLAG_EXPORT_ON_EXIT = `${exports.FLAG_EXPORT_ON_EXIT_NAME} [dir]`;
exports.DESC_EXPORT_ON_EXIT = "automatically export emulator data (emulators:export) " +
    "when the emulators make a clean exit (SIGINT), " +
    `when no dir is provided the location of ${exports.FLAG_IMPORT} is used`;
exports.EXPORT_ON_EXIT_USAGE_ERROR = `"${exports.FLAG_EXPORT_ON_EXIT_NAME}" must be used with "${exports.FLAG_IMPORT}"` +
    ` or provide a dir directly to "${exports.FLAG_EXPORT_ON_EXIT}"`;
exports.FLAG_UI = "--ui";
exports.DESC_UI = "run the Emulator UI";
exports.FLAG_TEST_CONFIG = "--test-config <firebase.json file>";
exports.DESC_TEST_CONFIG = "A firebase.json style file. Used to configure the Firestore and Realtime Database emulators.";
exports.FLAG_TEST_PARAMS = "--test-params <params.env file>";
exports.DESC_TEST_PARAMS = "A .env file containing test param values for your emulated extension.";
const DEFAULT_CONFIG = new Config({ database: {}, firestore: {}, functions: {}, hosting: {}, emulators: { auth: {}, pubsub: {} } }, {});
function printNoticeIfEmulated(options, emulator) {
    if (emulator !== types_1.Emulators.DATABASE && emulator !== types_1.Emulators.FIRESTORE) {
        return;
    }
    const emuName = constants_1.Constants.description(emulator);
    const envKey = emulator === types_1.Emulators.DATABASE
        ? constants_1.Constants.FIREBASE_DATABASE_EMULATOR_HOST
        : constants_1.Constants.FIRESTORE_EMULATOR_HOST;
    const envVal = process.env[envKey];
    if (envVal) {
        utils.logBullet(`You have set ${clc.bold(`${envKey}=${envVal}`)}, this command will execute against the ${emuName} running at that address.`);
    }
}
exports.printNoticeIfEmulated = printNoticeIfEmulated;
function warnEmulatorNotSupported(options, emulator) {
    if (emulator !== types_1.Emulators.DATABASE && emulator !== types_1.Emulators.FIRESTORE) {
        return;
    }
    const emuName = constants_1.Constants.description(emulator);
    const envKey = emulator === types_1.Emulators.DATABASE
        ? constants_1.Constants.FIREBASE_DATABASE_EMULATOR_HOST
        : constants_1.Constants.FIRESTORE_EMULATOR_HOST;
    const envVal = process.env[envKey];
    if (envVal) {
        utils.logWarning(`You have set ${clc.bold(`${envKey}=${envVal}`)}, however this command does not support running against the ${emuName} so this action will affect production.`);
        const opts = {
            confirm: undefined,
        };
        return prompt_1.prompt(opts, [
            {
                type: "confirm",
                name: "confirm",
                default: false,
                message: "Do you want to continue?",
            },
        ]).then(() => {
            if (!opts.confirm) {
                return utils.reject("Command aborted.", { exit: 1 });
            }
        });
    }
}
exports.warnEmulatorNotSupported = warnEmulatorNotSupported;
function beforeEmulatorCommand(options) {
    return __awaiter(this, void 0, void 0, function* () {
        const optionsWithDefaultConfig = Object.assign(Object.assign({}, options), { config: DEFAULT_CONFIG });
        const optionsWithConfig = options.config ? options : optionsWithDefaultConfig;
        const canStartWithoutConfig = options.only &&
            !controller.shouldStart(optionsWithConfig, types_1.Emulators.FUNCTIONS) &&
            !controller.shouldStart(optionsWithConfig, types_1.Emulators.HOSTING);
        try {
            yield requireAuth_1.requireAuth(options);
        }
        catch (e) {
            logger.debug(e);
            utils.logLabeledWarning("emulators", `You are not currently authenticated so some features may not work correctly. Please run ${clc.bold("firebase login")} to authenticate the CLI.`);
        }
        if (canStartWithoutConfig && !options.config) {
            utils.logWarning("Could not find config (firebase.json) so using defaults.");
            options.config = DEFAULT_CONFIG;
        }
        else {
            yield requireConfig(options);
        }
    });
}
exports.beforeEmulatorCommand = beforeEmulatorCommand;
function parseInspectionPort(options) {
    let port = options.inspectFunctions;
    if (port === true) {
        port = "9229";
    }
    const parsed = Number(port);
    if (isNaN(parsed) || parsed < 1024 || parsed > 65535) {
        throw new error_1.FirebaseError(`"${port}" is not a valid port for debugging, please pass an integer between 1024 and 65535.`);
    }
    return parsed;
}
exports.parseInspectionPort = parseInspectionPort;
function setExportOnExitOptions(options) {
    if (options.exportOnExit || typeof options.exportOnExit === "string") {
        if (options.import) {
            options.exportOnExit =
                typeof options.exportOnExit === "string" ? options.exportOnExit : options.import;
            const importPath = path.resolve(options.import);
            if (!fsutils.dirExistsSync(importPath) && options.import === options.exportOnExit) {
                options.exportOnExit = options.import;
                delete options.import;
            }
        }
        if (options.exportOnExit === true || !options.exportOnExit) {
            throw new error_1.FirebaseError(exports.EXPORT_ON_EXIT_USAGE_ERROR);
        }
    }
    return;
}
exports.setExportOnExitOptions = setExportOnExitOptions;
function processKillSignal(signal, res, rej, options) {
    let lastSignal = new Date().getTime();
    let signalCount = 0;
    return () => __awaiter(this, void 0, void 0, function* () {
        try {
            const now = new Date().getTime();
            const diff = now - lastSignal;
            if (diff < 100) {
                logger.debug(`Ignoring signal ${signal} due to short delay of ${diff}ms`);
                return;
            }
            signalCount = signalCount + 1;
            lastSignal = now;
            const signalDisplay = signal === "SIGINT" ? `SIGINT (Ctrl-C)` : signal;
            logger.debug(`Received signal ${signalDisplay} ${signalCount}`);
            logger.info(" ");
            if (signalCount === 1) {
                utils.logLabeledBullet("emulators", `Received ${signalDisplay} for the first time. Starting a clean shutdown.`);
                utils.logLabeledBullet("emulators", `Please wait for a clean shutdown or send the ${signalDisplay} signal again to stop right now.`);
                yield controller_1.onExit(options);
                yield controller.cleanShutdown();
            }
            else {
                logger.debug(`Skipping clean onExit() and cleanShutdown()`);
                const runningEmulatorsInfosWithPid = registry_1.EmulatorRegistry.listRunningWithInfo().filter((i) => Boolean(i.pid));
                utils.logLabeledWarning("emulators", `Received ${signalDisplay} ${signalCount} times. You have forced the Emulator Suite to exit without waiting for ${runningEmulatorsInfosWithPid.length} subprocess${runningEmulatorsInfosWithPid.length > 1 ? "es" : ""} to finish. These processes ${clc.bold("may")} still be running on your machine: `);
                const pids = [];
                const emulatorsTable = new Table({
                    head: ["Emulator", "Host:Port", "PID"],
                    style: {
                        head: ["yellow"],
                    },
                });
                for (const emulatorInfo of runningEmulatorsInfosWithPid) {
                    pids.push(emulatorInfo.pid);
                    emulatorsTable.push([
                        constants_1.Constants.description(emulatorInfo.name),
                        `${emulatorInfo.host}:${emulatorInfo.port}`,
                        emulatorInfo.pid,
                    ]);
                }
                logger.info(`\n${emulatorsTable}\n\nTo force them to exit run:\n`);
                if (process.platform === "win32") {
                    logger.info(clc.bold(`TASKKILL ${pids.map((pid) => "/PID " + pid).join(" ")} /T\n`));
                }
                else {
                    logger.info(clc.bold(`kill ${pids.join(" ")}\n`));
                }
            }
            res();
        }
        catch (e) {
            logger.debug(e);
            rej();
        }
    });
}
function shutdownWhenKilled(options) {
    return new Promise((res, rej) => {
        ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].forEach((signal) => {
            process.on(signal, processKillSignal(signal, res, rej, options));
        });
    })
        .then(() => {
        process.exit(0);
    })
        .catch((e) => {
        logger.debug(e);
        utils.logLabeledWarning("emulators", "emulators failed to shut down cleanly, see firebase-debug.log for details.");
        process.exit(1);
    });
}
exports.shutdownWhenKilled = shutdownWhenKilled;
function runScript(script, extraEnv) {
    return __awaiter(this, void 0, void 0, function* () {
        utils.logBullet(`Running script: ${clc.bold(script)}`);
        const env = Object.assign(Object.assign({}, process.env), extraEnv);
        const databaseInstance = registry_1.EmulatorRegistry.get(types_1.Emulators.DATABASE);
        if (databaseInstance) {
            const info = databaseInstance.getInfo();
            const address = `${info.host}:${info.port}`;
            env[constants_1.Constants.FIREBASE_DATABASE_EMULATOR_HOST] = address;
        }
        const firestoreInstance = registry_1.EmulatorRegistry.get(types_1.Emulators.FIRESTORE);
        if (firestoreInstance) {
            const info = firestoreInstance.getInfo();
            const address = `${info.host}:${info.port}`;
            env[constants_1.Constants.FIRESTORE_EMULATOR_HOST] = address;
            env[firestoreEmulator_1.FirestoreEmulator.FIRESTORE_EMULATOR_ENV_ALT] = address;
        }
        const hubInstance = registry_1.EmulatorRegistry.get(types_1.Emulators.HUB);
        if (hubInstance) {
            const info = hubInstance.getInfo();
            const address = `${info.host}:${info.port}`;
            env[hub_1.EmulatorHub.EMULATOR_HUB_ENV] = address;
        }
        const proc = childProcess.spawn(script, {
            stdio: ["inherit", "inherit", "inherit"],
            shell: true,
            windowsHide: true,
            env,
        });
        logger.debug(`Running ${script} with environment ${JSON.stringify(env)}`);
        return new Promise((resolve, reject) => {
            proc.on("error", (err) => {
                utils.logWarning(`There was an error running the script: ${JSON.stringify(err)}`);
                reject();
            });
            const exitDelayMs = 500;
            proc.once("exit", (code, signal) => {
                if (signal) {
                    utils.logWarning(`Script exited with signal: ${signal}`);
                    setTimeout(reject, exitDelayMs);
                    return;
                }
                const exitCode = code || 0;
                if (code === 0) {
                    utils.logSuccess(`Script exited successfully (code 0)`);
                }
                else {
                    utils.logWarning(`Script exited unsuccessfully (code ${code})`);
                }
                setTimeout(() => {
                    resolve(exitCode);
                }, exitDelayMs);
            });
        });
    });
}
function emulatorExec(script, options) {
    return __awaiter(this, void 0, void 0, function* () {
        shutdownWhenKilled(options);
        const projectId = getProjectId(options, true);
        const extraEnv = {};
        if (projectId) {
            extraEnv.GCLOUD_PROJECT = projectId;
        }
        let exitCode = 0;
        try {
            const excludeUi = !options.ui;
            yield controller.startAll(options, excludeUi);
            exitCode = yield runScript(script, extraEnv);
            yield controller_1.onExit(options);
        }
        finally {
            yield controller.cleanShutdown();
        }
        if (exitCode !== 0) {
            throw new error_1.FirebaseError(`Script "${clc.bold(script)}" exited with code ${exitCode}`, {
                exit: exitCode,
            });
        }
    });
}
exports.emulatorExec = emulatorExec;
