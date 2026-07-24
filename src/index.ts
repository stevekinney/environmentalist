import { EnvironmentalistError } from './errors.js';
import { environmentalist as environmentalistResolver } from './environmentalist.js';
import { registry, secret } from './metadata.js';
import {
  defineConfig as defineConfigHelper,
  toJSONSchema as toJSONSchemaHelper,
} from './tooling/index.js';
import {
  electronPaths as electronPathsHelper,
  createUserDataConfigSource as userDataSource,
} from './electron.js';
import { SOURCES, SCHEMA } from './types.js';
import { toPublic as toPublicHelper } from './validate.js';
import { createNodeWatcher as nodeWatcher } from './watch/node.js';
import type {
  CamelCasedPropertiesDeep,
  DeepPartial,
  EnvironmentalistOptions,
  Environment,
  SafeResult,
  SourceName,
  SourceSpec,
} from './types.js';
import type {
  WatchOptions,
  Watcher,
  EnvironmentChange,
  EnvironmentChangeEvent,
} from './watch/index.js';

const runtimeApi = {
  EnvironmentalistError,
  SCHEMA,
  SOURCES,
  createUserDataConfigSource: userDataSource,
  createWatcher: nodeWatcher,
  defineConfig: defineConfigHelper,
  electronPaths: electronPathsHelper,
  environmentalist: environmentalistResolver,
  registry,
  secret,
  toJSONSchema: toJSONSchemaHelper,
  toPublic: toPublicHelper,
};

const environmentalist = runtimeApi.environmentalist;
const createWatcher = runtimeApi.createWatcher;
const createUserDataConfigSource = runtimeApi.createUserDataConfigSource;
const defineConfig = runtimeApi.defineConfig;
const electronPaths = runtimeApi.electronPaths;
const toJSONSchema = runtimeApi.toJSONSchema;
const toPublic = runtimeApi.toPublic;

export {
  EnvironmentalistError,
  SCHEMA,
  SOURCES,
  createUserDataConfigSource,
  createWatcher,
  defineConfig,
  electronPaths,
  environmentalist,
  registry,
  secret,
  toJSONSchema,
  toPublic,
};

export type {
  WatchOptions,
  Watcher,
  EnvironmentChange,
  EnvironmentChangeEvent,
  CamelCasedPropertiesDeep,
  DeepPartial,
  EnvironmentalistOptions,
  Environment,
  SafeResult,
  SourceName,
  SourceSpec,
};
