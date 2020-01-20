import * as path from 'path';
import semver from 'semver';
import fs from 'fs-extra';
import R from 'ramda';
import pMapSeries from 'p-map-series';
import chalk from 'chalk';
import format from 'string-format';
import { getConsumerInfo } from './consumer-locator';
import { ConsumerNotFound, MissingDependencies } from './exceptions';
import { Driver } from '../driver';
import DriverNotFound from '../driver/exceptions/driver-not-found';
import WorkspaceConfig from './config/workspace-config';
import { BitId, BitIds } from '../bit-id';
import Component from './component';
import {
  BIT_HIDDEN_DIR,
  COMPONENT_ORIGINS,
  BIT_VERSION,
  NODE_PATH_COMPONENT_SEPARATOR,
  BIT_GIT_DIR,
  DOT_GIT_DIR,
  BIT_WORKSPACE_TMP_DIRNAME,
  COMPILER_ENV_TYPE,
  TESTER_ENV_TYPE,
  LATEST,
  DEPENDENCIES_FIELDS,
  DEFAULT_LANE
} from '../constants';
import { Scope, ComponentWithDependencies } from '../scope';
import migratonManifest from './migrations/consumer-migrator-manifest';
import migrate from './migrations/consumer-migrator';
import { ConsumerMigrationResult } from './migrations/consumer-migrator';
import loader from '../cli/loader';
import { BEFORE_MIGRATION } from '../cli/loader/loader-messages';
import BitMap from './bit-map/bit-map';
import { MissingBitMapComponent } from './bit-map/exceptions';
import logger from '../logger/logger';
import DirStructure from './dir-structure/dir-structure';
import { pathNormalizeToLinux, sortObject, isValidIdChunk } from '../utils';
import { ModelComponent, Version, Lane } from '../scope/models';
import MissingFilesFromComponent from './component/exceptions/missing-files-from-component';
import ComponentNotFoundInPath from './component/exceptions/component-not-found-in-path';
import * as packageJsonUtils from './component/package-json-utils';
import { Dependencies } from './component/dependencies';
import CompilerExtension from '../extensions/compiler-extension';
import TesterExtension from '../extensions/tester-extension';
import { PathOsBased, PathRelative, PathAbsolute, PathOsBasedAbsolute, PathOsBasedRelative } from '../utils/path';
import { Analytics } from '../analytics/analytics';
import GeneralError from '../error/general-error';
import tagModelComponent from '../scope/component-ops/tag-model-component';
import { InvalidComponent } from './component/consumer-component';
import { BitIdStr } from '../bit-id/bit-id';
import { WorkspaceConfigProps } from './config/workspace-config';
import { getAutoTagPending } from '../scope/component-ops/auto-tag';
import { ComponentNotFound } from '../scope/exceptions';
import VersionDependencies from '../scope/version-dependencies';
import {
  getManipulateDirWhenImportingComponents,
  getManipulateDirForExistingComponents
} from './component-ops/manipulate-dir';
import ComponentLoader from './component/component-loader';
import { getScopeRemotes } from '../scope/scope-remotes';
import ScopeComponentsImporter from '../scope/component-ops/scope-components-importer';
import installExtensions from '../scope/extensions/install-extensions';
import { Remotes } from '../remotes';
import { composeComponentPath, composeDependencyPath } from '../utils/bit/compose-component-path';
import ComponentOutOfSync from './exceptions/component-out-of-sync';
import getNodeModulesPathOfComponent from '../utils/bit/component-node-modules-path';
import makeEnv from '../extensions/env-factory';
import EnvExtension from '../extensions/env-extension';
import ComponentsPendingImport from './component-ops/exceptions/components-pending-import';
import { AutoTagResult } from '../scope/component-ops/auto-tag';
import ShowDoctorError from '../error/show-doctor-error';
import { EnvType } from '../extensions/env-extension-types';
import LaneId from '../lane-id/lane-id';
import snapModelComponents from '../scope/component-ops/snap-model-component';
import { LaneComponent } from '../scope/models/lane';
import WorkspaceLane from './bit-map/workspace-lane';

type ConsumerProps = {
  projectPath: string;
  config: WorkspaceConfig;
  scope: Scope;
  created?: boolean;
  isolated?: boolean;
  bitMap: BitMap;
  addedGitHooks?: string[] | null | undefined;
  existingGitHooks: string[] | null | undefined;
};

type ComponentStatus = {
  modified: boolean;
  newlyCreated: boolean;
  deleted: boolean;
  staged: boolean;
  notExist: boolean;
  missingFromScope: boolean;
  nested: boolean; // when a component is nested, it doesn't matter whether it was modified
};

/**
 * @todo: change the class name to Workspace
 */
export default class Consumer {
  projectPath: PathOsBased;
  created: boolean;
  config: WorkspaceConfig;
  scope: Scope;
  bitMap: BitMap;
  isolated = false; // Mark that the consumer instance is of isolated env and not real
  addedGitHooks: string[] | null | undefined; // list of git hooks added during init process
  existingGitHooks: string[] | null | undefined; // list of git hooks already exists during init process
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  _driver: Driver;
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  _dirStructure: DirStructure;
  _componentsStatusCache: Record<string, any> = {}; // cache loaded components
  packageManagerArgs: string[] = []; // args entered by the user in the command line after '--'
  componentLoader: ComponentLoader;

  constructor({
    projectPath,
    config,
    scope,
    created = false,
    isolated = false,
    bitMap,
    addedGitHooks,
    existingGitHooks
  }: ConsumerProps) {
    this.projectPath = projectPath;
    this.config = config;
    this.created = created;
    this.isolated = isolated;
    this.scope = scope;
    this.bitMap = bitMap || BitMap.load(projectPath, scope.path, scope.lanes.getCurrentLaneName());
    this.addedGitHooks = addedGitHooks;
    this.existingGitHooks = existingGitHooks;
    this.warnForMissingDriver();
    this.componentLoader = ComponentLoader.getInstance(this);
  }
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  get compiler(): Promise<CompilerExtension | null | undefined> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return this.getEnv(COMPILER_ENV_TYPE);
  }

  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  get tester(): Promise<TesterExtension | null | undefined> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return this.getEnv(TESTER_ENV_TYPE);
  }

  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  get driver(): Driver {
    if (!this._driver) {
      this._driver = Driver.load(this.config.lang);
    }
    return this._driver;
  }

  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  get dirStructure(): DirStructure {
    if (!this._dirStructure) {
      this._dirStructure = new DirStructure(
        this.config.componentsDefaultDirectory,
        this.config.dependenciesDirectory,
        this.config.ejectedEnvsDirectory
      );
    }
    return this._dirStructure;
  }

  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  get bitmapIds(): BitIds {
    return this.bitMap.getAllBitIds();
  }

  async getEnv(
    envType: EnvType,
    context: Record<string, any> | null | undefined
  ): Promise<EnvExtension | null | undefined> {
    const props = this._getEnvProps(envType, context);
    if (!props) return null;
    return makeEnv(envType, props);
  }

  getTmpFolder(fullPath = false): PathOsBased {
    if (!fullPath) {
      return BIT_WORKSPACE_TMP_DIRNAME;
    }
    return path.join(this.getPath(), BIT_WORKSPACE_TMP_DIRNAME);
  }

  getCurrentLaneId(): LaneId {
    return new LaneId({ name: this.scope.lanes.getCurrentLaneName() || DEFAULT_LANE });
  }

  async getCurrentLaneObject(): Promise<Lane | null> {
    const laneId = this.getCurrentLaneId();
    return this.scope.loadLane(laneId);
  }

  async createNewLane(laneName: string, laneComponents?: LaneComponent[]): Promise<Lane> {
    const lanes = await this.scope.listLanes();
    if (lanes.find(lane => lane.name === laneName)) {
      throw new GeneralError(
        `lane "${laneName}" already exists, to switch to this lane, please use "bit switch" command`
      );
    }
    if (!isValidIdChunk(laneName, false)) {
      // @todo: should we allow slash?
      throw new GeneralError(
        `lane "${laneName}" has invalid characters. lane name can only contain alphanumeric, lowercase characters, and the following ["-", "_", "$", "!"]`
      );
    }

    const getDataToPopulateLaneObjectIfNeeded = async (): Promise<LaneComponent[]> => {
      if (laneComponents) return laneComponents;
      // when branching from one lane to another, copy components from the origin lane
      // when branching from master, no need to copy anything
      const currentLaneObject = await this.getCurrentLaneObject();
      return currentLaneObject ? currentLaneObject.components : [];
    };
    const getDataToPopulateWorkspaceLaneIfNeeded = (): BitIds => {
      if (laneComponents) return new BitIds(); // if laneComponent, this got created when importing a remote lane
      // when branching from one lane to another, copy components from the origin workspace-lane
      // when branching from master, no need to copy anything
      const currentWorkspaceLane = this.bitMap.workspaceLane;
      return currentWorkspaceLane ? currentWorkspaceLane.ids : new BitIds();
    };
    const newLane = Lane.create(laneName);
    const dataToPopulate = await getDataToPopulateLaneObjectIfNeeded();
    newLane.setLaneComponents(dataToPopulate);

    await this.scope.lanes.saveLane(newLane, true);

    const workspaceConfig = WorkspaceLane.load(laneName, this.scope.getPath());
    workspaceConfig.ids = getDataToPopulateWorkspaceLaneIfNeeded();
    await workspaceConfig.write();

    return newLane;
  }

  async cleanTmpFolder() {
    const tmpPath = this.getTmpFolder(true);
    const exists = await fs.pathExists(tmpPath);
    if (exists) {
      logger.info(`consumer.cleanTmpFolder, deleting ${tmpPath}`);
      return fs.remove(tmpPath);
    }
    return null;
  }

  /**
   * Check if the driver installed and print message if not
   *
   *
   * @param {any} msg msg to print in case the driver not found (use string-format with the err context)
   * @returns {boolean} true if the driver exists, false otherwise
   * @memberof Consumer
   */
  warnForMissingDriver(msg?: string): boolean {
    try {
      this.driver.getDriver(false);

      return true;
    } catch (err) {
      msg = msg
        ? format(msg, err)
        : `Warning: Bit is not able to run the link command. Please install bit-${err.lang} driver and run the link command.`;
      if (err instanceof DriverNotFound) {
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        console.log(chalk.yellow(msg)); // eslint-disable-line
      }
      throw new GeneralError(`Failed loading the driver for ${this.config.lang}. Got an error from the driver: ${err}`);
    }
  }

  /**
   * Running migration process for consumer to update the stores (.bit.map.json) to the current version
   *
   * @param {any} verbose - print debug logs
   * @returns {Object} - wether the process run and wether it successeded
   * @memberof Consumer
   */
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  async migrate(verbose): Record<string, any> {
    // Check version of stores (bitmap / bitjson) to check if we need to run migrate
    // If migration is needed add loader - loader.start(BEFORE_MIGRATION);
    // bitmap migrate
    if (verbose) console.log('running migration process for consumer'); // eslint-disable-line
    // We start to use this process after version 0.10.9, so we assume the scope is in the last production version
    const bitmapVersion = this.bitMap.version || '0.10.9';

    if (semver.gte(bitmapVersion, BIT_VERSION)) {
      logger.debug('bit.map version is up to date');
      return {
        run: false
      };
    }
    loader.start(BEFORE_MIGRATION);
    logger.debugAndAddBreadCrumb(
      'consumer.migrate',
      `start consumer migration. bitmapVersion version ${bitmapVersion}, bit version ${BIT_VERSION}`
    );

    const result: ConsumerMigrationResult = await migrate(bitmapVersion, migratonManifest, this.bitMap, verbose);
    result.bitMap.version = BIT_VERSION;
    // mark the bitmap as changed to make sure it persist to FS
    result.bitMap.markAsChanged();
    // Update the version of the bitmap instance of the consumer (to prevent duplicate migration)
    this.bitMap.version = result.bitMap.version;
    await result.bitMap.write();

    loader.stop();

    return {
      run: true,
      success: true
    };
  }

  async write(): Promise<Consumer> {
    await Promise.all([this.config.write({ workspaceDir: this.projectPath }), this.scope.ensureDir()]);
    this.bitMap.markAsChanged();
    await this.bitMap.write();
    return this;
  }

  getPath(): PathOsBased {
    return this.projectPath;
  }

  toAbsolutePath(pathStr: PathRelative): PathOsBasedAbsolute {
    if (path.isAbsolute(pathStr)) throw new Error(`toAbsolutePath expects relative path, got ${pathStr}`);
    return path.join(this.projectPath, pathStr);
  }

  getPathRelativeToConsumer(pathToCheck: PathRelative | PathAbsolute): PathOsBasedRelative {
    const absolutePath = path.resolve(pathToCheck); // if pathToCheck was absolute, it returns it back
    return path.relative(this.getPath(), absolutePath);
  }

  getParsedId(id: BitIdStr): BitId {
    // $FlowFixMe, bitId is always defined as shouldThrow is true
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const bitId: BitId = this.bitMap.getExistingBitId(id);
    const version = BitId.getVersionOnlyFromString(id);
    return bitId.changeVersion(version || LATEST);
  }

  getParsedIdIfExist(id: BitIdStr): BitId | null | undefined {
    const bitId: BitId | null | undefined = this.bitMap.getExistingBitId(id, false);
    if (!bitId) return null;
    const version = BitId.getVersionOnlyFromString(id);
    return bitId.changeVersion(version);
  }

  /**
   * throws a ComponentNotFound exception if not found in the model
   */
  async loadComponentFromModel(id: BitId): Promise<Component> {
    if (!id.version) throw new TypeError('consumer.loadComponentFromModel, version is missing from the id');
    const modelComponent: ModelComponent = await this.scope.getModelComponent(id);

    const componentVersion = modelComponent.toComponentVersion(id.version);
    const manipulateDirData = await getManipulateDirForExistingComponents(this, componentVersion);
    return modelComponent.toConsumerComponent(id.version, this.scope.name, this.scope.objects, manipulateDirData);
  }

  /**
   * return a component only when it's stored locally.
   * don't go to any remote server and don't throw an exception if the component is not there.
   */
  async loadComponentFromModelIfExist(id: BitId): Promise<Component | null | undefined> {
    if (!id.version) return null;
    return this.loadComponentFromModel(id).catch(err => {
      if (err instanceof ComponentNotFound) return null;
      throw err;
    });
  }

  async loadAllVersionsOfComponentFromModel(id: BitId): Promise<Component[]> {
    const modelComponent: ModelComponent = await this.scope.getModelComponent(id);
    const componentsP = modelComponent.listVersions().map(async versionNum => {
      const componentVersion = modelComponent.toComponentVersion(versionNum);
      const manipulateDirData = await getManipulateDirForExistingComponents(this, componentVersion);
      return modelComponent.toConsumerComponent(versionNum, this.scope.name, this.scope.objects, manipulateDirData);
    });
    return Promise.all(componentsP);
  }

  async loadComponentWithDependenciesFromModel(id: BitId, throwIfNotExist = true): Promise<ComponentWithDependencies> {
    const scopeComponentsImporter = ScopeComponentsImporter.getInstance(this.scope);
    const getModelComponent = async (): Promise<ModelComponent> => {
      if (throwIfNotExist) return this.scope.getModelComponent(id);
      const modelComponent = await this.scope.getModelComponentIfExist(id);
      if (modelComponent) return modelComponent;
      await scopeComponentsImporter.importMany(new BitIds(id));
      return this.scope.getModelComponent(id);
    };
    const modelComponent = await getModelComponent();
    if (!id.version) {
      throw new TypeError('consumer.loadComponentWithDependenciesFromModel, version is missing from the id');
    }

    const versionDependencies = await scopeComponentsImporter.componentToVersionDependencies(modelComponent, id);
    const manipulateDirData = await getManipulateDirWhenImportingComponents(
      this.bitMap,
      [versionDependencies],
      this.scope.objects
    );
    return versionDependencies.toConsumer(this.scope.objects, manipulateDirData);
  }

  async loadComponent(id: BitId): Promise<Component> {
    const { components } = await this.loadComponents(BitIds.fromArray([id]));
    return components[0];
  }

  loadComponentForCapsule(id: BitId): Promise<Component> {
    return this.componentLoader.loadForCapsule(id);
  }

  async loadComponents(
    ids: BitIds,
    throwOnFailure = true
  ): Promise<{ components: Component[]; invalidComponents: InvalidComponent[] }> {
    return this.componentLoader.loadMany(ids, throwOnFailure);
  }

  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  importEnvironment(bitId: BitId, verbose?: boolean, dontPrintEnvMsg: boolean): Promise<ComponentWithDependencies[]> {
    return installExtensions({ ids: [{ componentId: bitId }], scope: this.scope, verbose, dontPrintEnvMsg });
  }

  async importComponents(
    ids: BitIds,
    withAllVersions: boolean,
    saveDependenciesAsComponents?: boolean
  ): Promise<ComponentWithDependencies[]> {
    const scopeComponentsImporter = ScopeComponentsImporter.getInstance(this.scope);
    const versionDependenciesArr: VersionDependencies[] = withAllVersions
      ? await scopeComponentsImporter.importManyWithAllVersions(ids, false)
      : await scopeComponentsImporter.importMany(ids);
    const shouldDependenciesSavedAsComponents = await this.shouldDependenciesSavedAsComponents(
      versionDependenciesArr.map(v => v.component.id),
      saveDependenciesAsComponents
    );
    const manipulateDirData = await getManipulateDirWhenImportingComponents(
      this.bitMap,
      versionDependenciesArr,
      this.scope.objects
    );
    const componentWithDependencies = await pMapSeries(versionDependenciesArr, versionDependencies =>
      versionDependencies.toConsumer(this.scope.objects, manipulateDirData)
    );
    componentWithDependencies.forEach(componentWithDeps => {
      const shouldSavedAsComponents = shouldDependenciesSavedAsComponents.find(c =>
        c.id.isEqual(componentWithDeps.component.id)
      );
      if (!shouldSavedAsComponents) {
        throw new Error(`saveDependenciesAsComponents is missing for ${componentWithDeps.component.id.toString()}`);
      }
      componentWithDeps.component.dependenciesSavedAsComponents = shouldSavedAsComponents.saveDependenciesAsComponents;
    });
    return componentWithDependencies;
  }

  async shouldDependenciesSavedAsComponents(bitIds: BitId[], saveDependenciesAsComponents?: boolean) {
    if (saveDependenciesAsComponents === undefined) {
      saveDependenciesAsComponents = this.config.saveDependenciesAsComponents;
    }
    const remotes: Remotes = await getScopeRemotes(this.scope);
    const shouldDependenciesSavedAsComponents = bitIds.map((bitId: BitId) => {
      return {
        id: bitId, // if it doesn't go to the hub, it can't import dependencies as packages
        saveDependenciesAsComponents: saveDependenciesAsComponents || !remotes.isHub(bitId.scope)
      };
    });
    return shouldDependenciesSavedAsComponents;
  }

  /**
   * By default, the dists paths are inside the component.
   * If dist attribute is populated in bit.json, the paths are in consumer-root/dist-target.
   */
  shouldDistsBeInsideTheComponent(): boolean {
    return !this.config.distEntry && !this.config.distTarget;
  }

  potentialComponentsForAutoTagging(modifiedComponents: BitIds): BitIds {
    const candidateComponents = this.bitMap.getAuthoredAndImportedBitIds();
    const modifiedComponentsWithoutVersions = modifiedComponents.map(modifiedComponent =>
      modifiedComponent.toStringWithoutVersion()
    );
    // if a modified component is in candidates array, remove it from the array as it will be already tagged with the
    // correct version
    const idsWithoutModified = candidateComponents.filter(
      component => !modifiedComponentsWithoutVersions.includes(component.toStringWithoutVersion())
    );
    return BitIds.fromArray(idsWithoutModified);
  }

  async listComponentsForAutoTagging(modifiedComponents: BitIds): Promise<ModelComponent[]> {
    const candidateComponents = this.potentialComponentsForAutoTagging(modifiedComponents);
    return getAutoTagPending(this.scope, candidateComponents, modifiedComponents);
  }

  /**
   * Check whether a model representation and file-system representation of the same component is the same.
   * The way how it is done is by converting the file-system representation of the component into
   * a Version object. Once this is done, we have two Version objects, and we can compare their hashes
   */
  async isComponentModified(componentFromModel: Version, componentFromFileSystem: Component): Promise<boolean> {
    if (!(componentFromModel instanceof Version)) {
      throw new TypeError(
        `isComponentModified expects componentFromModel to be Version, got ${typeof componentFromModel}`
      );
    }
    if (!(componentFromFileSystem instanceof Component)) {
      throw new TypeError(
        `isComponentModified expects componentFromFileSystem to be ConsumerComponent, got ${typeof componentFromFileSystem}`
      );
    }
    if (typeof componentFromFileSystem._isModified === 'undefined') {
      const componentMap = this.bitMap.getComponent(componentFromFileSystem.id);
      if (componentMap.originallySharedDir) {
        componentFromFileSystem.originallySharedDir = componentMap.originallySharedDir;
      }
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      const { version } = await this.scope.sources.consumerComponentToVersion({
        consumer: this,
        consumerComponent: componentFromFileSystem
      });

      version.log = componentFromModel.log; // ignore the log, it's irrelevant for the comparison

      // sometime dependencies from the FS don't have an exact version.
      const copyDependenciesVersionsFromModelToFS = (dependenciesFS: Dependencies, dependenciesModel: Dependencies) => {
        dependenciesFS.get().forEach(dependency => {
          const dependencyFromModel = dependenciesModel
            .get()
            .find(modelDependency => modelDependency.id.isEqualWithoutVersion(dependency.id));
          if (dependencyFromModel && !dependency.id.hasVersion()) {
            dependency.id = dependencyFromModel.id;
          }
        });
      };
      copyDependenciesVersionsFromModelToFS(version.dependencies, componentFromModel.dependencies);
      copyDependenciesVersionsFromModelToFS(version.devDependencies, componentFromModel.devDependencies);
      copyDependenciesVersionsFromModelToFS(version.compilerDependencies, componentFromModel.compilerDependencies);
      copyDependenciesVersionsFromModelToFS(version.testerDependencies, componentFromModel.testerDependencies);

      sortProperties(version);

      // prefix your command with "BIT_LOG=*" to see the actual id changes
      if (process.env.BIT_LOG && componentFromModel.calculateHash().hash !== version.calculateHash().hash) {
        console.log('-------------------componentFromModel------------------------'); // eslint-disable-line no-console
        console.log(componentFromModel.id()); // eslint-disable-line no-console
        console.log('------------------------componentFromFileSystem (version)----'); // eslint-disable-line no-console
        console.log(version.id()); // eslint-disable-line no-console
        console.log('-------------------------END---------------------------------'); // eslint-disable-line no-console
      }
      componentFromFileSystem._isModified = componentFromModel.calculateHash().hash !== version.calculateHash().hash;
    }
    return componentFromFileSystem._isModified;

    function sortProperties(version) {
      // sort the files by 'relativePath' because the order can be changed when adding or renaming
      // files in bitmap, which affects later on the model.
      version.files = R.sortBy(R.prop('relativePath'), version.files);
      componentFromModel.files = R.sortBy(R.prop('relativePath'), componentFromModel.files);
      version.dependencies.sort();
      version.devDependencies.sort();
      version.compilerDependencies.sort();
      version.testerDependencies.sort();
      version.packageDependencies = sortObject(version.packageDependencies);
      version.devPackageDependencies = sortObject(version.devPackageDependencies);
      version.compilerPackageDependencies = sortObject(version.compilerPackageDependencies);
      version.testerPackageDependencies = sortObject(version.testerPackageDependencies);
      version.peerPackageDependencies = sortObject(version.peerPackageDependencies);
      sortOverrides(version.overrides);
      componentFromModel.dependencies.sort();
      componentFromModel.devDependencies.sort();
      componentFromModel.compilerDependencies.sort();
      componentFromModel.testerDependencies.sort();
      componentFromModel.packageDependencies = sortObject(componentFromModel.packageDependencies);
      componentFromModel.devPackageDependencies = sortObject(componentFromModel.devPackageDependencies);
      componentFromModel.compilerPackageDependencies = sortObject(componentFromModel.compilerPackageDependencies);
      componentFromModel.testerPackageDependencies = sortObject(componentFromModel.testerPackageDependencies);
      componentFromModel.peerPackageDependencies = sortObject(componentFromModel.peerPackageDependencies);
      sortOverrides(componentFromModel.overrides);
    }
    function sortOverrides(overrides) {
      if (!overrides) return;
      DEPENDENCIES_FIELDS.forEach(field => {
        if (overrides[field]) overrides[field] = sortObject(overrides[field]);
      });
    }
  }

  /**
   * Get a component status by ID. Return a ComponentStatus object.
   * Keep in mind that a result can be a partial object of ComponentStatus, e.g. { notExist: true }.
   * Each one of the ComponentStatus properties can be undefined, true or false.
   * As a result, in order to check whether a component is not modified use (status.modified === false).
   * Don't use (!status.modified) because a component may not exist and the status.modified will be undefined.
   *
   * The status may have 'true' for several properties. For example, a component can be staged and modified at the
   * same time.
   *
   * The result is cached per ID and can be called several times with no penalties.
   */
  async getComponentStatusById(id: BitId): Promise<ComponentStatus> {
    const getStatus = async () => {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      const status: ComponentStatus = {};
      const componentFromModel: ModelComponent | null | undefined = await this.scope.getModelComponentIfExist(id);
      let componentFromFileSystem;
      try {
        // change to 'latest' before loading from FS. don't change to null, otherwise, it'll cause
        // loadOne to not find model component as it assumes there is no version
        // also, don't leave the id as is, otherwise, it'll cause issues with import --merge, when
        // imported version is bigger than .bitmap, it won't find it and will consider as deleted
        componentFromFileSystem = await this.loadComponent(id.changeVersion(LATEST));
      } catch (err) {
        if (
          err instanceof MissingFilesFromComponent ||
          err instanceof ComponentNotFoundInPath ||
          err instanceof MissingBitMapComponent
        ) {
          // the file/s have been deleted or the component doesn't exist in bit.map file
          if (componentFromModel) status.deleted = true;
          else status.notExist = true;
          return status;
        }
        if (err instanceof ComponentsPendingImport) {
          status.missingFromScope;
          return status;
        }
        throw err;
      }
      if (componentFromFileSystem.componentMap.origin === COMPONENT_ORIGINS.NESTED) {
        status.nested = true;
        return status;
      }
      if (!componentFromModel) {
        status.newlyCreated = true;
        return status;
      }

      const lane = await this.scope.loadLane(this.getCurrentLaneId());
      status.staged = await componentFromModel.isLocallyChangedOnLane(this.scope.objects, lane);
      const versionFromFs = componentFromFileSystem.id.version;
      const idStr = id.toString();
      if (!componentFromFileSystem.id.hasVersion()) {
        throw new ComponentOutOfSync(idStr);
      }
      // TODO: instead of doing that like this we should use:
      // const versionFromModel = await componentFromModel.loadVersion(versionFromFs, this.scope.objects);
      // it looks like it's exactly the same code but it's not working from some reason
      const versionRef = componentFromModel.getRef(versionFromFs);
      if (!versionRef) throw new ShowDoctorError(`version ${versionFromFs} was not found in ${idStr}`);
      const versionFromModel = await this.scope.getObject(versionRef.hash);
      if (!versionFromModel) {
        throw new ShowDoctorError(`failed loading version ${versionFromFs} of ${idStr} from the scope`);
      }
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      status.modified = await this.isComponentModified(versionFromModel, componentFromFileSystem);
      return status;
    };
    if (!this._componentsStatusCache[id.toString()]) {
      this._componentsStatusCache[id.toString()] = await getStatus();
    }
    return this._componentsStatusCache[id.toString()];
  }

  async tag(
    ids: BitIds,
    message: string,
    exactVersion: string | null | undefined,
    releaseType: semver.ReleaseType,
    force: boolean | null | undefined,
    verbose: boolean | null | undefined,
    ignoreUnresolvedDependencies: boolean | null | undefined,
    ignoreNewestVersion: boolean,
    skipTests = false,
    skipAutoTag: boolean
  ): Promise<{ taggedComponents: Component[]; autoTaggedResults: AutoTagResult[] }> {
    logger.debug(`tagging the following components: ${ids.toString()}`);
    Analytics.addBreadCrumb('tag', `tagging the following components: ${Analytics.hashData(ids)}`);
    const { components } = await this.loadComponents(ids);
    // go through the components list to check if there are missing dependencies
    // if there is at least one we won't tag anything
    if (!ignoreUnresolvedDependencies) {
      const componentsWithMissingDeps = components.filter(component => {
        return Boolean(component.issues);
      });
      if (!R.isEmpty(componentsWithMissingDeps)) throw new MissingDependencies(componentsWithMissingDeps);
    }
    const areComponentsMissingFromScope = components.some(c => !c.componentFromModel && c.id.hasScope());
    if (areComponentsMissingFromScope) {
      throw new ComponentsPendingImport();
    }

    const { taggedComponents, autoTaggedResults } = await tagModelComponent({
      consumerComponents: components,
      scope: this.scope,
      message,
      exactVersion,
      releaseType,
      force,
      consumer: this,
      ignoreNewestVersion,
      skipTests,
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      verbose,
      skipAutoTag
    });

    const autoTaggedComponents = autoTaggedResults.map(r => r.component);
    const allComponents = [...taggedComponents, ...autoTaggedComponents];
    await this.updateComponentsVersions(allComponents);

    return { taggedComponents, autoTaggedResults };
  }

  async snap({
    ids,
    message = '',
    ignoreUnresolvedDependencies = false,
    force = false,
    skipTests = false,
    verbose = false,
    skipAutoSnap = false,
    resolveUnmerged = false
  }: {
    ids: BitIds;
    message?: string;
    ignoreUnresolvedDependencies?: boolean;
    force?: boolean;
    skipTests?: boolean;
    verbose?: boolean;
    skipAutoSnap?: boolean;
    resolveUnmerged?: boolean;
  }): Promise<{ snappedComponents: Component[]; autoSnappedResults: AutoTagResult[] }> {
    logger.debug(`snapping the following components: ${ids.toString()}`);
    Analytics.addBreadCrumb('snap', `snapping the following components: ${Analytics.hashData(ids)}`);
    const { components } = await this.loadComponents(ids);
    // go through the components list to check if there are missing dependencies
    // if there is at least one we won't snap anything
    if (!ignoreUnresolvedDependencies) {
      const componentsWithMissingDeps = components.filter(component => {
        return Boolean(component.issues);
      });
      if (!R.isEmpty(componentsWithMissingDeps)) throw new MissingDependencies(componentsWithMissingDeps);
    }
    const areComponentsMissingFromScope = components.some(c => !c.componentFromModel && c.id.hasScope());
    if (areComponentsMissingFromScope) {
      throw new ComponentsPendingImport();
    }

    const { taggedComponents, autoTaggedResults } = await snapModelComponents({
      consumerComponents: components,
      scope: this.scope,
      message,
      force,
      consumer: this,
      skipTests,
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      verbose,
      skipAutoSnap,
      resolveUnmerged
    });

    const autoTaggedComponents = autoTaggedResults.map(r => r.component);
    const allComponents = [...taggedComponents, ...autoTaggedComponents];
    await this.updateComponentsVersions(allComponents);

    return { snappedComponents: taggedComponents, autoSnappedResults: autoTaggedResults };
  }

  updateComponentsVersions(components: Array<ModelComponent | Component>): Promise<any> {
    const getPackageJsonDir = (
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      componentMap: ComponentMap,
      bitId: BitId,
      bindingPrefix: string
    ): PathRelative | null | undefined => {
      if (componentMap.rootDir) return componentMap.rootDir;
      // it's author
      if (!bitId.hasScope()) return null;
      return getNodeModulesPathOfComponent(bindingPrefix, bitId);
    };
    const currentLane = this.getCurrentLaneId();
    const isAvailableOnMaster = async (component: ModelComponent | Component): Promise<boolean> => {
      if (currentLane.isDefault()) return true;
      const modelComponent =
        component instanceof ModelComponent ? component : await this.scope.getModelComponent(component.id);
      return modelComponent.hasSnapHead();
    };

    const updateVersionsP = components.map(async component => {
      const id: BitId =
        component instanceof ModelComponent ? component.toBitIdWithLatestVersionAllowNull() : component.id;
      this.bitMap.updateComponentId(id);
      const availableOnMaster = await isAvailableOnMaster(component);
      if (!availableOnMaster) {
        this.bitMap.setComponentProp(id, 'onLanesOnly', true);
      }
      const componentMap = this.bitMap.getComponent(id);
      const packageJsonDir = getPackageJsonDir(componentMap, id, component.bindingPrefix);
      return packageJsonDir // if it has package.json, it's imported, which must have a version
        ? packageJsonUtils.updateAttribute(this, packageJsonDir, 'version', id.version as string)
        : Promise.resolve();
    });
    return Promise.all(updateVersionsP);
  }

  getComponentIdFromNodeModulesPath(requirePath: string, bindingPrefix: string): BitId {
    requirePath = pathNormalizeToLinux(requirePath);
    // Temp fix to support old components before the migration has been running
    bindingPrefix = bindingPrefix === 'bit' ? '@bit' : bindingPrefix;
    const prefix = requirePath.includes('node_modules') ? `node_modules/${bindingPrefix}/` : `${bindingPrefix}/`;
    const withoutPrefix = requirePath.substr(requirePath.indexOf(prefix) + prefix.length);
    const componentName = withoutPrefix.includes('/')
      ? withoutPrefix.substr(0, withoutPrefix.indexOf('/')) // the part after the first slash is the path inside the package
      : withoutPrefix;
    const pathSplit = componentName.split(NODE_PATH_COMPONENT_SEPARATOR);
    if (pathSplit.length < 2) throw new GeneralError(`component has an invalid require statement: ${requirePath}`);
    // since the dynamic namespaces feature introduced, the require statement doesn't have a fixed
    // number of separators.
    // also, a scope name may or may not include a dot. depends whether it's on bitHub or self hosted.
    // we must check against BitMap to get the correct scope and name of the id.
    if (pathSplit.length === 2) {
      return new BitId({ scope: pathSplit[0], name: pathSplit[1] });
    }
    const mightBeScope = R.head(pathSplit);
    const mightBeName = R.tail(pathSplit).join('/');
    const mightBeId = new BitId({ scope: mightBeScope, name: mightBeName });
    const allBitIds = this.bitMap.getAllBitIds();
    if (allBitIds.searchWithoutVersion(mightBeId)) return mightBeId;
    // only bit hub has the concept of having the username in the scope name.
    if (bindingPrefix !== 'bit' && bindingPrefix !== '@bit') return mightBeId;
    // pathSplit has 3 or more items. the first two are the scope, the rest is the name.
    // for example "user.scopeName.utils.is-string" => scope: user.scopeName, name: utils/is-string
    const scope = pathSplit.splice(0, 2).join('.');
    const name = pathSplit.join('/');
    return new BitId({ scope, name });
  }

  composeRelativeComponentPath(bitId: BitId): string {
    const { componentsDefaultDirectory } = this.dirStructure;
    return composeComponentPath(bitId, componentsDefaultDirectory);
  }

  composeComponentPath(bitId: BitId): PathOsBasedAbsolute {
    const addToPath = [this.getPath(), this.composeRelativeComponentPath(bitId)];
    logger.debug(`component dir path: ${addToPath.join('/')}`);
    Analytics.addBreadCrumb('composeComponentPath', `component dir path: ${Analytics.hashData(addToPath.join('/'))}`);
    return path.join(...addToPath);
  }

  composeRelativeDependencyPath(bitId: BitId): PathOsBased {
    const dependenciesDir = this.dirStructure.dependenciesDirStructure;
    return composeDependencyPath(bitId, dependenciesDir);
  }

  composeDependencyPath(bitId: BitId): PathOsBased {
    const relativeDependencyPath = this.composeRelativeDependencyPath(bitId);
    return path.join(this.getPath(), relativeDependencyPath);
  }

  static create(
    projectPath: PathOsBasedAbsolute,
    noGit = false,
    workspaceConfigProps: WorkspaceConfigProps
  ): Promise<Consumer> {
    return this.ensure(projectPath, noGit, workspaceConfigProps);
  }

  static _getScopePath(projectPath: PathOsBasedAbsolute, noGit: boolean): PathOsBasedAbsolute {
    const gitDirPath = path.join(projectPath, DOT_GIT_DIR);
    let resolvedScopePath = path.join(projectPath, BIT_HIDDEN_DIR);
    if (!noGit && fs.existsSync(gitDirPath) && !fs.existsSync(resolvedScopePath)) {
      resolvedScopePath = path.join(gitDirPath, BIT_GIT_DIR);
    }
    return resolvedScopePath;
  }

  static async ensure(
    projectPath: PathOsBasedAbsolute,
    standAlone = false,
    workspaceConfigProps: WorkspaceConfigProps
  ): Promise<Consumer> {
    const resolvedScopePath = Consumer._getScopePath(projectPath, standAlone);
    let existingGitHooks;
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const scopeP = Scope.ensure(resolvedScopePath);
    const configP = WorkspaceConfig.ensure(projectPath, standAlone, workspaceConfigProps);
    const [scope, config] = await Promise.all([scopeP, configP]);
    const bitMap = BitMap.load(projectPath, scope.path, scope.lanes.getCurrentLaneName());
    return new Consumer({
      projectPath,
      created: true,
      scope,
      config,
      bitMap,
      existingGitHooks
    });
  }

  /**
   * if resetHard, delete consumer-files: bitMap and bit.json and also the local scope (.bit dir).
   * otherwise, delete the consumer-files only when they are corrupted
   */
  static async reset(projectPath: PathOsBasedAbsolute, resetHard: boolean, noGit = false): Promise<void> {
    const resolvedScopePath = Consumer._getScopePath(projectPath, noGit);
    BitMap.reset(projectPath, resetHard, resolvedScopePath);
    const scopeP = Scope.reset(resolvedScopePath, resetHard);
    const configP = WorkspaceConfig.reset(projectPath, resetHard);
    await Promise.all([scopeP, configP]);
  }

  static async createIsolatedWithExistingScope(consumerPath: PathOsBased, scope: Scope): Promise<Consumer> {
    // if it's an isolated environment, it's normal to have already the consumer
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const config = await WorkspaceConfig.ensure(consumerPath);
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return new Consumer({
      projectPath: consumerPath,
      created: true,
      scope,
      isolated: true,
      config
    });
  }

  static locateProjectScope(projectPath: string) {
    if (fs.existsSync(path.join(projectPath, DOT_GIT_DIR, BIT_GIT_DIR))) {
      return path.join(projectPath, DOT_GIT_DIR, BIT_GIT_DIR);
    }
    if (fs.existsSync(path.join(projectPath, BIT_HIDDEN_DIR))) {
      return path.join(projectPath, BIT_HIDDEN_DIR);
    }
    return null;
  }
  static async load(currentPath: PathOsBasedAbsolute): Promise<Consumer> {
    const consumerInfo = await getConsumerInfo(currentPath);
    if (!consumerInfo) {
      return Promise.reject(new ConsumerNotFound());
    }
    if ((!consumerInfo.consumerConfig || !consumerInfo.hasScope) && consumerInfo.hasBitMap) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      const consumer = await Consumer.create(consumerInfo.path);
      await Promise.all([consumer.config.write({ workspaceDir: consumer.projectPath }), consumer.scope.ensureDir()]);
      consumerInfo.consumerConfig = await WorkspaceConfig.load(consumerInfo.path);
    }
    const scopePath = Consumer.locateProjectScope(consumerInfo.path);
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const scope = await Scope.load(scopePath);
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return new Consumer({
      projectPath: consumerInfo.path,
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      config: consumerInfo.consumerConfig,
      scope
    });
  }

  /**
   * clean up removed components from bitmap
   * @param {BitIds} componentsToRemoveFromFs - delete component that are used by other components.
   * @param {BitIds} removedDependencies - delete component that are used by other components.
   */
  async cleanFromBitMap(componentsToRemoveFromFs: BitIds, removedDependencies: BitIds) {
    logger.debug(`consumer.cleanFromBitMap, cleaning ${componentsToRemoveFromFs.toString()} from .bitmap`);
    this.bitMap.removeComponents(componentsToRemoveFromFs);
    this.bitMap.removeComponents(removedDependencies);
  }

  async addRemoteAndLocalVersionsToDependencies(component: Component, loadedFromFileSystem: boolean) {
    logger.debug(`addRemoteAndLocalVersionsToDependencies for ${component.id.toString()}`);
    Analytics.addBreadCrumb(
      'addRemoteAndLocalVersionsToDependencies',
      `addRemoteAndLocalVersionsToDependencies for ${Analytics.hashData(component.id.toString())}`
    );
    let modelDependencies = new Dependencies([]);
    let modelDevDependencies = new Dependencies([]);
    let modelCompilerDependencies = new Dependencies([]);
    let modelTesterDependencies = new Dependencies([]);
    if (loadedFromFileSystem) {
      // when loaded from file-system, the dependencies versions are fetched from bit.map.
      // find the model version of the component and get the stored versions of the dependencies
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      const mainComponentFromModel: Component = component.componentFromModel;
      if (mainComponentFromModel) {
        // otherwise, the component is probably on the file-system only and not on the model.
        modelDependencies = mainComponentFromModel.dependencies;
        modelDevDependencies = mainComponentFromModel.devDependencies;
        modelCompilerDependencies = mainComponentFromModel.compilerDependencies;
        modelTesterDependencies = mainComponentFromModel.testerDependencies;
      }
    }
    await component.dependencies.addRemoteAndLocalVersions(this.scope, modelDependencies);
    await component.devDependencies.addRemoteAndLocalVersions(this.scope, modelDevDependencies);
    await component.compilerDependencies.addRemoteAndLocalVersions(this.scope, modelCompilerDependencies);
    await component.testerDependencies.addRemoteAndLocalVersions(this.scope, modelTesterDependencies);
  }

  async getAuthoredAndImportedDependentsIdsOf(components: Component[]): Promise<BitIds> {
    const authoredAndImportedComponents = this.bitMap.getAllIdsAvailableOnLane([
      COMPONENT_ORIGINS.IMPORTED,
      COMPONENT_ORIGINS.AUTHORED
    ]);
    const componentsIds = BitIds.fromArray(components.map(c => c.id));
    return this.scope.findDirectDependentComponents(authoredAndImportedComponents, componentsIds);
  }

  async getAuthoredAndImportedDependentsComponentsOf(components: Component[]): Promise<Component[]> {
    const dependentsIds = await this.getAuthoredAndImportedDependentsIdsOf(components);
    const scopeComponentsImporter = ScopeComponentsImporter.getInstance(this.scope);

    const versionDependenciesArr = await scopeComponentsImporter.importMany(dependentsIds, true, false);
    const manipulateDirData = await getManipulateDirWhenImportingComponents(
      this.bitMap,
      versionDependenciesArr,
      this.scope.objects
    );
    const dependentComponentsP = versionDependenciesArr.map(c =>
      c.component.toConsumer(this.scope.objects, manipulateDirData)
    );
    return Promise.all(dependentComponentsP);
  }

  async ejectConf(componentId: BitId, { ejectPath }: { ejectPath: string | null | undefined }) {
    const component = await this.loadComponent(componentId);
    return component.writeConfig(this, ejectPath || this.dirStructure.ejectedEnvsDirStructure);
  }

  async injectConf(componentId: BitId, force: boolean) {
    const component = await this.loadComponent(componentId);
    return component.injectConfig(this.getPath(), this.bitMap, force);
  }

  _getEnvProps(envType: EnvType, context: Record<string, any> | null | undefined) {
    const envs = this.config.getEnvsByType(envType);
    if (!envs) return undefined;
    const envName = Object.keys(envs)[0];
    const envObject = envs[envName];
    return {
      name: envName,
      consumerPath: this.getPath(),
      scopePath: this.scope.getPath(),
      rawConfig: envObject.rawConfig,
      files: envObject.files,
      bitJsonPath: path.dirname(this.config.path),
      options: envObject.options,
      envType,
      context
    };
  }

  async onDestroy() {
    await this.cleanTmpFolder();
    await this.scope.scopeJson.writeIfChanged(this.scope.path);
    return this.bitMap.write();
  }
}
