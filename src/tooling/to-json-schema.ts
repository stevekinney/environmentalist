/* eslint-disable typescript/no-unsafe-type-assertion */

import { z } from 'zod';

import { metadataFor } from '../metadata.js';
import { schemaShape } from '../resolve-core.js';

type SchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addMetadata(schema: SchemaRecord, field: z.ZodType): void {
  const metadata = metadataFor(field);
  if (metadata.description !== undefined && schema['description'] === undefined) {
    schema['description'] = metadata.description;
  }
  if (metadata.example !== undefined && schema['example'] === undefined) {
    schema['example'] = metadata.example;
  }
}

function patchProperties(field: z.ZodType, emitted: unknown): void {
  const shape = schemaShape(field);
  if (shape === undefined || !isRecord(emitted)) return;
  const properties = emitted['properties'];
  if (!isRecord(properties)) return;

  for (const [key, child] of Object.entries(shape)) {
    const emittedChild = properties[key];
    if (!isRecord(emittedChild)) continue;
    addMetadata(emittedChild, child as z.ZodType);
    patchProperties(child as z.ZodType, emittedChild);
  }
}

/** Convert a Zod v4 schema to JSON Schema, including Environmentalist metadata. */
export function toJSONSchema(schema: z.ZodType): z.core.JSONSchema.BaseSchema {
  const emitted = z.toJSONSchema(schema);
  patchProperties(schema, emitted);
  return emitted;
}
