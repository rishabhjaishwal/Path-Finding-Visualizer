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
exports.FunctionsEmulator = void 0;
const _ = require("lodash");
const path = require("path");
const express = require("express");
const clc = require("cli-color");
const http = require("http");
const jwt = require("jsonwebtoken");
const api = require("../api");
const logger = require("../logger");
const track = require("../track");
const constants_1 = require("./constants");
const types_1 = require("./types");
const chokidar = require("chokidar");
const spawn = require("cross-spawn");
const child_process_1 = require("child_process");
const functionsEmulatorShared_1 = require("./functionsEmulatorShared");
const registry_1 = require("./registry");
const events_1 = require("events");
const emulatorLogger_1 = require("./emulatorLogger");
const functionsRuntimeWorker_1 = require("./functionsRuntimeWorker");
const error_1 = require("../error");
const workQueue_1 = require("./workQueue");
const utils_1 = require("../utils");
const defaultCredentials_1 = require("../defaultCredentials");
const EVENT_INVOKE = "functions:invoke";
const DATABASE_PATH_PATTERN = new RegExp("^projects/[^/]+/instances/([^/]+)/refs(/.*)$");
class FunctionsEmulator {
    constructor(args) {
        this.args = args;
        this.nodeBinary = "";
        this.triggers = [];
        this.knownTriggerIDs = {};
        this.logger = emulatorLogger_1.EmulatorLogger.forEmulator(types_1.Emulators.FUNCTIONS);
        this.multicastTriggers = {};
        emulatorLogger_1.EmulatorLogger.verbosity = this.args.quiet ? emulatorLogger_1.Verbosity.QUIET : emulatorLogger_1.Verbosity.DEBUG;
        if (this.args.debugPort) {
            this.args.disabledRuntimeFeatures = this.args.disabledRuntimeFeatures || {};
            this.args.disabledRuntimeFeatures.timeout = true;
        }
        const mode = this.args.debugPort
            ? types_1.FunctionsExecutionMode.SEQUENTIAL
            : types_1.FunctionsExecutionMode.AUTO;
        this.workerPool = new functionsRuntimeWorker_1.RuntimeWorkerPool(mode);
        this.workQueue = new workQueue_1.WorkQueue(mode);
    }
    static getHttpFunctionUrl(host, port, projectId, name, region) {
        return `http://${host}:${port}/${projectId}/${region}/${name}`;
    }
    getCredentialsEnvironment() {
        return __awaiter(this, void 0, void 0, function* () {
            const credentialEnv = {};
            if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                this.logger.logLabeled("WARN", "functions", `Your GOOGLE_APPLICATION_CREDENTIALS environment variable points to ${process.env.GOOGLE_APPLICATION_CREDENTIALS}. Non-emulated services will access production using these credentials. Be careful!`);
            }
            else {
                const defaultCredPath = yield defaultCredentials_1.getCredentialPathAsync();
                if (defaultCredPath) {
                    this.logger.log("DEBUG", `Setting GAC to ${defaultCredPath}`);
                    credentialEnv.GOOGLE_APPLICATION_CREDENTIALS = defaultCredPath;
                }
                else {
                    this.logger.logLabeled("WARN", "functions", "You are not signed in to the Firebase CLI. If you have authorized this machine using gcloud application-default credentials those may be discovered and used to access production services.");
                }
            }
            return credentialEnv;
        });
    }
    createHubServer() {
        this.workQueue.start();
        const hub = express();
        const dataMiddleware = (req, res, next) => {
            const chunks = [];
            req.on("data", (chunk) => {
                chunks.push(chunk);
            });
            req.on("end", () => {
                req.rawBody = Buffer.concat(chunks);
                next();
            });
        };
        const backgroundFunctionRoute = `/functions/projects/:project_id/triggers/:trigger_name`;
        const httpsFunctionRoute = `/${this.args.projectId}/:region/:trigger_name`;
        const multicastFunctionRoute = `/functions/projects/:project_id/trigger_multicast`;
        const httpsFunctionRoutes = [httpsFunctionRoute, `${httpsFunctionRoute}/*`];
        const backgroundHandler = (req, res) => __awaiter(this, void 0, void 0, function* () {
            const triggerId = req.params.trigger_name;
            const projectId = req.params.project_id;
            const reqBody = req.rawBody;
            const proto = JSON.parse(reqBody.toString());
            this.workQueue.submit(() => {
                this.logger.log("DEBUG", `Accepted request ${req.method} ${req.url} --> ${triggerId}`);
                return this.handleBackgroundTrigger(projectId, triggerId, proto)
                    .then((x) => res.json(x))
                    .catch((errorBundle) => {
                    if (errorBundle.body) {
                        res.status(errorBundle.code).send(errorBundle.body);
                    }
                    else {
                        res.sendStatus(errorBundle.code);
                    }
                });
            });
        });
        const httpsHandler = (req, res) => __awaiter(this, void 0, void 0, function* () {
            this.workQueue.submit(() => {
                return this.handleHttpsTrigger(req, res);
            });
        });
        const multicastHandler = (req, res) => __awaiter(this, void 0, void 0, function* () {
            const reqBody = req.rawBody;
            const proto = JSON.parse(reqBody.toString());
            const triggers = this.multicastTriggers[`${this.args.projectId}:${proto.eventType}`] || [];
            const projectId = req.params.project_id;
            triggers.forEach((triggerId) => {
                this.workQueue.submit(() => {
                    this.logger.log("DEBUG", `Accepted multicast request ${req.method} ${req.url} --> ${triggerId}`);
                    return this.handleBackgroundTrigger(projectId, triggerId, proto);
                });
            });
            res.json({ status: "multicast_acknowledged" });
        });
        hub.post(backgroundFunctionRoute, dataMiddleware, backgroundHandler);
        hub.post(multicastFunctionRoute, dataMiddleware, multicastHandler);
        hub.all(httpsFunctionRoutes, dataMiddleware, httpsHandler);
        hub.all("*", dataMiddleware, (req, res) => {
            logger.debug(`Functions emulator received unknown request at path ${req.path}`);
            res.sendStatus(404);
        });
        return hub;
    }
    startFunctionRuntime(triggerId, triggerType, proto, runtimeOpts) {
        const bundleTemplate = this.getBaseBundle();
        const runtimeBundle = Object.assign(Object.assign({}, bundleTemplate), { emulators: {
                firestore: this.getEmulatorInfo(types_1.Emulators.FIRESTORE),
                database: this.getEmulatorInfo(types_1.Emulators.DATABASE),
                pubsub: this.getEmulatorInfo(types_1.Emulators.PUBSUB),
            }, nodeMajorVersion: this.args.nodeMajorVersion, proto,
            triggerId,
            triggerType });
        const opts = runtimeOpts || {
            nodeBinary: this.nodeBinary,
            env: this.args.env,
            extensionTriggers: this.args.predefinedTriggers,
        };
        const worker = this.invokeRuntime(runtimeBundle, opts);
        return worker;
    }
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            this.nodeBinary = this.askInstallNodeVersion(this.args.functionsDir, this.args.nodeMajorVersion);
            const credentialEnv = yield this.getCredentialsEnvironment();
            this.args.env = Object.assign(Object.assign({}, credentialEnv), this.args.env);
            const { host, port } = this.getInfo();
            this.workQueue.start();
            const server = this.createHubServer().listen(port, host);
            this.destroyServer = utils_1.createDestroyer(server);
            return Promise.resolve();
        });
    }
    connect() {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.logLabeled("BULLET", "functions", `Watching "${this.args.functionsDir}" for Cloud Functions...`);
            const watcher = chokidar.watch(this.args.functionsDir, {
                ignored: [
                    /.+?[\\\/]node_modules[\\\/].+?/,
                    /(^|[\/\\])\../,
                    /.+\.log/,
                ],
                persistent: true,
            });
            const loadTriggers = () => __awaiter(this, void 0, void 0, function* () {
                this.workerPool.refresh();
                const worker = this.invokeRuntime(this.getBaseBundle(), {
                    nodeBinary: this.nodeBinary,
                    env: this.args.env,
                    extensionTriggers: this.args.predefinedTriggers,
                });
                const triggerParseEvent = yield types_1.EmulatorLog.waitForLog(worker.runtime.events, "SYSTEM", "triggers-parsed");
                const triggerDefinitions = triggerParseEvent.data
                    .triggerDefinitions;
                const toSetup = triggerDefinitions.filter((definition) => !this.knownTriggerIDs[definition.name]);
                this.triggers = triggerDefinitions;
                const triggerResults = [];
                for (const definition of toSetup) {
                    if (definition.httpsTrigger) {
                        const region = functionsEmulatorShared_1.getFunctionRegion(definition);
                        const { host, port } = this.getInfo();
                        const url = FunctionsEmulator.getHttpFunctionUrl(host, port, this.args.projectId, definition.name, region);
                        triggerResults.push({
                            name: definition.name,
                            type: "http",
                            labels: definition.labels,
                            details: url,
                        });
                    }
                    else {
                        const service = functionsEmulatorShared_1.getFunctionService(definition);
                        const result = {
                            name: definition.name,
                            type: constants_1.Constants.getServiceName(service),
                            labels: definition.labels,
                        };
                        let added = false;
                        switch (service) {
                            case constants_1.Constants.SERVICE_FIRESTORE:
                                added = yield this.addFirestoreTrigger(this.args.projectId, definition);
                                break;
                            case constants_1.Constants.SERVICE_REALTIME_DATABASE:
                                added = yield this.addRealtimeDatabaseTrigger(this.args.projectId, definition);
                                break;
                            case constants_1.Constants.SERVICE_PUBSUB:
                                added = yield this.addPubsubTrigger(this.args.projectId, definition);
                                break;
                            case constants_1.Constants.SERVICE_AUTH:
                                added = yield this.addAuthTrigger(this.args.projectId, definition);
                                break;
                            default:
                                this.logger.log("DEBUG", `Unsupported trigger: ${JSON.stringify(definition)}`);
                                break;
                        }
                        result.ignored = !added;
                        triggerResults.push(result);
                    }
                    this.knownTriggerIDs[definition.name] = true;
                }
                const successTriggers = triggerResults.filter((r) => !r.ignored);
                for (const result of successTriggers) {
                    const msg = result.details
                        ? `${clc.bold(result.type)} function initialized (${result.details}).`
                        : `${clc.bold(result.type)} function initialized.`;
                    this.logger.logLabeled("SUCCESS", `functions[${result.name}]`, msg);
                }
                const ignoreTriggers = triggerResults.filter((r) => r.ignored);
                for (const result of ignoreTriggers) {
                    const msg = `function ignored because the ${result.type} emulator does not exist or is not running.`;
                    this.logger.logLabeled("BULLET", `functions[${result.name}]`, msg);
                }
            });
            const debouncedLoadTriggers = _.debounce(loadTriggers, 1000);
            watcher.on("change", (filePath) => {
                this.logger.log("DEBUG", `File ${filePath} changed, reloading triggers`);
                return debouncedLoadTriggers();
            });
            return loadTriggers();
        });
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.workQueue.flush();
            }
            catch (e) {
                this.logger.logLabeled("WARN", "functions", "Functions emulator work queue did not empty before stopping");
            }
            this.workQueue.stop();
            this.workerPool.exit();
            if (this.destroyServer) {
                yield this.destroyServer();
            }
        });
    }
    addRealtimeDatabaseTrigger(projectId, definition) {
        const databaseEmu = registry_1.EmulatorRegistry.get(types_1.Emulators.DATABASE);
        if (!databaseEmu) {
            return Promise.resolve(false);
        }
        const databaseHost = databaseEmu.getInfo().host;
        const databasePort = databaseEmu.getInfo().port;
        if (!definition.eventTrigger) {
            this.logger.log("WARN", `Event trigger "${definition.name}" has undefined "eventTrigger" member`);
            return Promise.reject();
        }
        const result = DATABASE_PATH_PATTERN.exec(definition.eventTrigger.resource);
        if (result === null || result.length !== 3) {
            this.logger.log("WARN", `Event trigger "${definition.name}" has malformed "resource" member. ` +
                `${definition.eventTrigger.resource}`);
            return Promise.reject();
        }
        const instance = result[1];
        const bundle = JSON.stringify({
            name: `projects/${projectId}/locations/_/functions/${definition.name}`,
            path: result[2],
            event: definition.eventTrigger.eventType,
            topic: `projects/${projectId}/topics/${definition.name}`,
        });
        logger.debug(`addDatabaseTrigger[${instance}]`, JSON.stringify(bundle));
        let setTriggersPath = "/.settings/functionTriggers.json";
        if (instance !== "") {
            setTriggersPath += `?ns=${instance}`;
        }
        else {
            this.logger.log("WARN", `No project in use. Registering function trigger for sentinel namespace '${constants_1.Constants.DEFAULT_DATABASE_EMULATOR_NAMESPACE}'`);
        }
        return api
            .request("POST", setTriggersPath, {
            origin: `http://${databaseHost}:${databasePort}`,
            headers: {
                Authorization: "Bearer owner",
            },
            data: bundle,
            json: false,
        })
            .then(() => {
            return true;
        })
            .catch((err) => {
            this.logger.log("WARN", "Error adding trigger: " + err);
            throw err;
        });
    }
    addFirestoreTrigger(projectId, definition) {
        const firestoreEmu = registry_1.EmulatorRegistry.get(types_1.Emulators.FIRESTORE);
        if (!firestoreEmu) {
            return Promise.resolve(false);
        }
        const firestoreHost = firestoreEmu.getInfo().host;
        const firestorePort = firestoreEmu.getInfo().port;
        const bundle = JSON.stringify({ eventTrigger: definition.eventTrigger });
        logger.debug(`addFirestoreTrigger`, JSON.stringify(bundle));
        return api
            .request("PUT", `/emulator/v1/projects/${projectId}/triggers/${definition.name}`, {
            origin: `http://${firestoreHost}:${firestorePort}`,
            data: bundle,
            json: false,
        })
            .then(() => {
            return true;
        })
            .catch((err) => {
            this.logger.log("WARN", "Error adding trigger: " + err);
            throw err;
        });
    }
    addPubsubTrigger(projectId, definition) {
        return __awaiter(this, void 0, void 0, function* () {
            const pubsubPort = registry_1.EmulatorRegistry.getPort(types_1.Emulators.PUBSUB);
            if (!pubsubPort) {
                return false;
            }
            if (!definition.eventTrigger) {
                return false;
            }
            const pubsubEmulator = registry_1.EmulatorRegistry.get(types_1.Emulators.PUBSUB);
            logger.debug(`addPubsubTrigger`, JSON.stringify({ eventTrigger: definition.eventTrigger }));
            const resource = definition.eventTrigger.resource;
            let topic;
            if (definition.schedule) {
                topic = "firebase-schedule-" + definition.name;
            }
            else {
                const resourceParts = resource.split("/");
                topic = resourceParts[resourceParts.length - 1];
            }
            try {
                yield pubsubEmulator.addTrigger(topic, definition.name);
                return true;
            }
            catch (e) {
                return false;
            }
        });
    }
    addAuthTrigger(projectId, definition) {
        var _a;
        logger.debug(`addAuthTrigger`, JSON.stringify({ eventTrigger: definition.eventTrigger }));
        const eventTriggerId = `${projectId}:${(_a = definition.eventTrigger) === null || _a === void 0 ? void 0 : _a.eventType}`;
        const triggers = this.multicastTriggers[eventTriggerId] || [];
        triggers.push(definition.entryPoint);
        this.multicastTriggers[eventTriggerId] = triggers;
        return true;
    }
    getProjectId() {
        return this.args.projectId;
    }
    getInfo() {
        const host = this.args.host || constants_1.Constants.getDefaultHost(types_1.Emulators.FUNCTIONS);
        const port = this.args.port || constants_1.Constants.getDefaultPort(types_1.Emulators.FUNCTIONS);
        return {
            name: this.getName(),
            host,
            port,
        };
    }
    getName() {
        return types_1.Emulators.FUNCTIONS;
    }
    getTriggers() {
        return this.triggers;
    }
    getTriggerById(triggerId) {
        for (const trigger of this.triggers) {
            if (trigger.name === triggerId) {
                return trigger;
            }
        }
        throw new error_1.FirebaseError(`No trigger with name ${triggerId}`);
    }
    setTriggersForTesting(triggers) {
        this.triggers = triggers;
    }
    getBaseBundle() {
        return {
            cwd: this.args.functionsDir,
            projectId: this.args.projectId,
            triggerId: "",
            triggerType: undefined,
            emulators: {
                firestore: registry_1.EmulatorRegistry.getInfo(types_1.Emulators.FIRESTORE),
                database: registry_1.EmulatorRegistry.getInfo(types_1.Emulators.DATABASE),
                pubsub: registry_1.EmulatorRegistry.getInfo(types_1.Emulators.PUBSUB),
            },
            disabled_features: this.args.disabledRuntimeFeatures,
        };
    }
    askInstallNodeVersion(cwd, nodeMajorVersion) {
        const pkg = require(path.join(cwd, "package.json"));
        if ((!pkg.engines || !pkg.engines.node) && !nodeMajorVersion) {
            this.logger.log("WARN", "Your functions directory does not specify a Node version.\n   " +
                "- Learn more at https://firebase.google.com/docs/functions/manage-functions#set_runtime_options");
            return process.execPath;
        }
        const hostMajorVersion = process.versions.node.split(".")[0];
        const requestedMajorVersion = nodeMajorVersion
            ? `${nodeMajorVersion}`
            : pkg.engines.node;
        let localMajorVersion = "0";
        const localNodePath = path.join(cwd, "node_modules/.bin/node");
        try {
            const localNodeOutput = child_process_1.spawnSync(localNodePath, ["--version"]).stdout.toString();
            localMajorVersion = localNodeOutput.slice(1).split(".")[0];
        }
        catch (err) {
        }
        if (requestedMajorVersion === hostMajorVersion) {
            this.logger.logLabeled("SUCCESS", "functions", `Using node@${requestedMajorVersion} from host.`);
            return process.execPath;
        }
        if (localMajorVersion === requestedMajorVersion) {
            this.logger.logLabeled("SUCCESS", "functions", `Using node@${requestedMajorVersion} from local cache.`);
            return localNodePath;
        }
        this.logger.log("WARN", `Your requested "node" version "${requestedMajorVersion}" doesn't match your global version "${hostMajorVersion}"`);
        return process.execPath;
    }
    invokeRuntime(frb, opts) {
        if (this.workerPool.readyForWork(frb.triggerId)) {
            return this.workerPool.submitWork(frb.triggerId, frb, opts);
        }
        const emitter = new events_1.EventEmitter();
        const args = [path.join(__dirname, "functionsEmulatorRuntime")];
        if (opts.ignore_warnings) {
            args.unshift("--no-warnings");
        }
        if (this.args.debugPort) {
            const { host } = this.getInfo();
            args.unshift(`--inspect=${host}:${this.args.debugPort}`);
        }
        const childProcess = spawn(opts.nodeBinary, args, {
            env: Object.assign(Object.assign({ node: opts.nodeBinary }, opts.env), process.env),
            cwd: frb.cwd,
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        const buffers = {
            stderr: { pipe: childProcess.stderr, value: "" },
            stdout: { pipe: childProcess.stdout, value: "" },
        };
        const ipcBuffer = { value: "" };
        childProcess.on("message", (message) => {
            this.onData(childProcess, emitter, ipcBuffer, message);
        });
        for (const id in buffers) {
            if (buffers.hasOwnProperty(id)) {
                const buffer = buffers[id];
                buffer.pipe.on("data", (buf) => {
                    this.onData(childProcess, emitter, buffer, buf);
                });
            }
        }
        const runtime = {
            pid: childProcess.pid,
            exit: new Promise((resolve) => {
                childProcess.on("exit", resolve);
            }),
            events: emitter,
            shutdown: () => {
                childProcess.kill();
            },
            kill: (signal) => {
                childProcess.kill(signal);
                emitter.emit("log", new types_1.EmulatorLog("SYSTEM", "runtime-status", "killed"));
            },
            send: (args) => {
                return childProcess.send(JSON.stringify(args));
            },
        };
        this.workerPool.addWorker(frb.triggerId, runtime);
        return this.workerPool.submitWork(frb.triggerId, frb, opts);
    }
    handleBackgroundTrigger(projectId, triggerId, proto) {
        return __awaiter(this, void 0, void 0, function* () {
            const trigger = this.getTriggerById(triggerId);
            const service = functionsEmulatorShared_1.getFunctionService(trigger);
            const worker = this.startFunctionRuntime(triggerId, functionsEmulatorShared_1.EmulatedTriggerType.BACKGROUND, proto);
            return new Promise((resolve, reject) => {
                if (projectId !== this.args.projectId) {
                    if (service !== constants_1.Constants.SERVICE_REALTIME_DATABASE) {
                        logger.debug(`Received functions trigger for service "${service}" for unknown project "${projectId}".`);
                        reject({ code: 404 });
                        return;
                    }
                    if (!trigger.eventTrigger.resource.startsWith(`projects/_/instances/${projectId}`)) {
                        logger.debug(`Received functions trigger for function "${triggerId}" of project "${projectId}" that did not match definition: ${JSON.stringify(trigger)}.`);
                        reject({ code: 404 });
                        return;
                    }
                }
                worker.onLogs((el) => {
                    if (el.level === "FATAL") {
                        reject({ code: 500, body: el.text });
                    }
                });
                if (triggerId) {
                    const trigger = this.getTriggerById(triggerId);
                    track(EVENT_INVOKE, functionsEmulatorShared_1.getFunctionService(trigger));
                }
                worker.waitForDone().then(() => {
                    resolve({ status: "acknowledged" });
                });
            });
        });
    }
    getEmulatorInfo(emulator) {
        if (this.args.remoteEmulators) {
            if (this.args.remoteEmulators[emulator]) {
                return this.args.remoteEmulators[emulator];
            }
        }
        return registry_1.EmulatorRegistry.getInfo(emulator);
    }
    tokenFromAuthHeader(authHeader) {
        const match = authHeader.match(/^Bearer (.*)$/);
        if (!match) {
            return;
        }
        let idToken = match[1];
        logger.debug(`ID Token: ${idToken}`);
        if (idToken && idToken.includes("=")) {
            idToken = idToken.replace(/[=]+?\./g, ".");
            logger.debug(`ID Token contained invalid padding, new value: ${idToken}`);
        }
        try {
            const decoded = jwt.decode(idToken, { complete: true });
            if (!decoded || typeof decoded !== "object") {
                logger.debug(`Failed to decode ID Token: ${decoded}`);
                return;
            }
            const claims = decoded.payload;
            claims.uid = claims.sub;
            return claims;
        }
        catch (e) {
            return;
        }
    }
    handleHttpsTrigger(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            const method = req.method;
            const triggerId = req.params.trigger_name;
            const trigger = this.getTriggerById(triggerId);
            logger.debug(`Accepted request ${method} ${req.url} --> ${triggerId}`);
            const reqBody = req.rawBody;
            const isCallable = trigger.labels && trigger.labels["deployment-callable"] === "true";
            const authHeader = req.header("Authorization");
            if (authHeader && isCallable) {
                const token = this.tokenFromAuthHeader(authHeader);
                if (token) {
                    const contextAuth = {
                        uid: token.uid,
                        token: token,
                    };
                    req.headers[functionsEmulatorShared_1.HttpConstants.ORIGINAL_AUTH_HEADER] = req.headers["authorization"];
                    delete req.headers["authorization"];
                    req.headers[functionsEmulatorShared_1.HttpConstants.CALLABLE_AUTH_HEADER] = encodeURIComponent(JSON.stringify(contextAuth));
                }
            }
            const worker = this.startFunctionRuntime(triggerId, functionsEmulatorShared_1.EmulatedTriggerType.HTTPS, undefined);
            worker.onLogs((el) => {
                if (el.level === "FATAL") {
                    res.status(500).send(el.text);
                }
            });
            yield worker.waitForSocketReady();
            track(EVENT_INVOKE, "https");
            this.logger.log("DEBUG", `[functions] Runtime ready! Sending request!`);
            if (!worker.lastArgs) {
                throw new error_1.FirebaseError("Cannot execute on a worker with no arguments");
            }
            if (!worker.lastArgs.frb.socketPath) {
                throw new error_1.FirebaseError(`Cannot execute on a worker without a socketPath: ${JSON.stringify(worker.lastArgs)}`);
            }
            const runtimeReq = http.request({
                method,
                path: req.url || "/",
                headers: req.headers,
                socketPath: worker.lastArgs.frb.socketPath,
            }, (runtimeRes) => {
                function forwardStatusAndHeaders() {
                    res.status(runtimeRes.statusCode || 200);
                    if (!res.headersSent) {
                        Object.keys(runtimeRes.headers).forEach((key) => {
                            const val = runtimeRes.headers[key];
                            if (val) {
                                res.setHeader(key, val);
                            }
                        });
                    }
                }
                runtimeRes.on("data", (buf) => {
                    forwardStatusAndHeaders();
                    res.write(buf);
                });
                runtimeRes.on("close", () => {
                    forwardStatusAndHeaders();
                    res.end();
                });
                runtimeRes.on("end", () => {
                    forwardStatusAndHeaders();
                    res.end();
                });
            });
            runtimeReq.on("error", () => {
                res.end();
            });
            if (reqBody) {
                runtimeReq.write(reqBody);
                runtimeReq.end();
            }
            req.pipe(runtimeReq, { end: true }).on("error", () => {
                res.end();
            });
            yield worker.waitForDone();
        });
    }
    onData(runtime, emitter, buffer, buf) {
        buffer.value += buf.toString();
        const lines = buffer.value.split("\n");
        if (lines.length > 1) {
            lines.slice(0, -1).forEach((line) => {
                const log = types_1.EmulatorLog.fromJSON(line);
                emitter.emit("log", log);
                if (log.level === "FATAL") {
                    emitter.emit("log", new types_1.EmulatorLog("SYSTEM", "runtime-status", "killed"));
                    runtime.kill();
                }
            });
        }
        buffer.value = lines[lines.length - 1];
    }
}
exports.FunctionsEmulator = FunctionsEmulator;
