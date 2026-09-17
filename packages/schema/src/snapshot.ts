import { z } from "zod";
import { digestSchema } from "./ids.js";

/**
 * Bounded repository observation. The observer never dumps the whole
 * repository; it builds progressively scoped context.
 */

export const manifestSummarySchema = z.strictObject({
  path: z.string(),
  kind: z.string(),
  name: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export const directorySummarySchema = z.strictObject({
  path: z.string(),
  entryCount: z.number().int().nonnegative(),
});

export const repositorySnapshotSchema = z.strictObject({
  revision: z.string(),
  dirty: z.boolean(),
  languages: z.array(z.string()),
  manifests: z.array(manifestSummarySchema),
  directories: z.array(directorySummarySchema),
  tests: z.array(z.strictObject({ path: z.string() })),
  commands: z.strictObject({
    build: z.string().optional(),
    test: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
  }),
  relevantArtifacts: z.array(
    z.strictObject({
      path: z.string(),
      reason: z.string(),
    }),
  ),
  createdAt: z.string(),
  digest: digestSchema,
});

export type ManifestSummary = z.infer<typeof manifestSummarySchema>;
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
