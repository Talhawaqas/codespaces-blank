// scripts/docs/generate-openapi.mjs
//
// Official Documentation Platform SOW -- generates a real OpenAPI 3.0
// document directly from src/lib/docsApiReference.js, the same
// hand-verified data the /docs/api pages render from. No OpenAPI spec
// existed anywhere in this repo before this (confirmed in the Phase 0
// audit, docs/audit/documentation-inventory.md), and there's no route
// annotation system to generate FROM the actual route files yet -- this
// generator sits one layer up (source-verified reference data -> schema),
// so the reference data stays the single source of truth for both the
// rendered pages and the spec, rather than two hand-maintained copies.
//
// Run with: node scripts/docs/generate-openapi.mjs
// Output: public/openapi.json (served statically at /openapi.json)

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_ENDPOINTS, API_AUTH_NOTE } from "../../src/lib/docsApiReference.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "../../public/openapi.json");

function pathParams(pathTemplate) {
  const matches = [...pathTemplate.matchAll(/\{([^}]+)\}/g)];
  return matches.map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
    description: `The ${m[1]}.`,
  }));
}

function queryParams(ep) {
  return ep.params
    .filter((p) => p.in.startsWith("query"))
    .map((p) => ({
      name: p.name,
      in: "query",
      required: p.required === true,
      schema: { type: "string" },
      description: p.description,
    }));
}

function requestBodySchema(ep) {
  const bodyParams = ep.params.filter((p) => p.in.startsWith("body"));
  if (bodyParams.length === 0) return undefined;
  const properties = {};
  for (const p of bodyParams) {
    // p.name is sometimes a comma-separated list (e.g. "type, name, region, capacity, performanceProfile, tags")
    for (const field of p.name.split(",").map((s) => s.trim())) {
      properties[field] = { description: p.description };
    }
  }
  return {
    required: bodyParams.some((p) => p.required === true || (typeof p.required === "string" && p.required.length > 0)),
    content: {
      "application/json": {
        schema: { type: "object", properties },
      },
    },
  };
}

function buildOperation(ep, method) {
  const op = {
    summary: ep.summary,
    operationId: `${method.toLowerCase()}_${ep.slug}`,
    tags: [ep.path.split("/").slice(0, 5).join("/")],
    parameters: [...pathParams(ep.path), ...(method === "GET" ? queryParams(ep) : [])],
    responses: {
      200: {
        description: ep.response,
        content: { "application/json": { schema: { type: "object" } } },
      },
      401: { description: "Missing or invalid API key." },
      403: { description: "The API key's organization does not have access to this capability." },
      404: { description: "The requested resource does not exist, or does not belong to this API key's organization." },
    },
    security: [{ bearerAuth: [] }],
  };
  if (op.parameters.length === 0) delete op.parameters;
  if (method === "POST" || method === "PATCH") {
    const body = requestBodySchema(ep);
    if (body) op.requestBody = body;
  }
  return op;
}

function buildSpec() {
  const paths = {};
  for (const ep of API_ENDPOINTS) {
    const methods = ep.method.split(",").map((m) => m.trim());
    paths[ep.path] = paths[ep.path] || {};
    for (const method of methods) {
      paths[ep.path][method.toLowerCase()] = buildOperation(ep, method);
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Inaya Network Public API",
      version: "v1",
      description: API_AUTH_NOTE,
    },
    servers: [{ url: "https://app.inaya.network", description: "Production" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "An Inaya org API key. See /docs/api." },
      },
    },
    paths,
  };
}

async function main() {
  const spec = buildSpec();
  await writeFile(OUTPUT_PATH, JSON.stringify(spec, null, 2) + "\n", "utf8");
  console.log(`Generated ${OUTPUT_PATH} — ${Object.keys(spec.paths).length} paths, ${API_ENDPOINTS.length} endpoints.`);
}

main().catch((err) => {
  console.error("OpenAPI generation failed:", err);
  process.exit(1);
});
