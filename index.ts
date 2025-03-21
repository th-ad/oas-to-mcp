import { parseArgs } from "node:util";
import { OpenAPIV3 } from "openapi-types";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

async function loadSpec(source: string): Promise<OpenAPIV3.Document> {
  try {
    if (source.startsWith("http")) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch spec: ${response.statusText} (${response.status})`,
        );
      }
      const spec = await response.json();
      return (await SwaggerParser.parse(spec)) as OpenAPIV3.Document;
    } else {
      return (await SwaggerParser.parse(source)) as OpenAPIV3.Document;
    }
  } catch (error) {
    console.error("Failed to load OpenAPI spec:", error);
    process.exit(1);
  }
}

function generateToolName(
  path: string,
  method: string,
  operation: OpenAPIV3.OperationObject,
): string {
  if (operation.operationId) {
    return operation.operationId;
  }

  const pathParts = path
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/\{([^}]+)\}/g, "$1"))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());

  return `${method.toLowerCase()}${pathParts.join("")}`;
}

async function startServer(spec: OpenAPIV3.Document) {
  const server = new Server(
    {
      name: "oas-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const serverUrl = spec.servers?.[0]?.url || "https://api.example.com";
  const tools = [];
  const toolHandlers = new Map();

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue;

    const pathParams = pathItem.parameters || [];

    for (const method of ["get", "put", "post", "delete", "patch"] as const) {
      const operation = pathItem[method];
      if (!operation) continue;

      const toolName = generateToolName(path, method, operation);

      const properties: Record<string, any> = {};
      const requiredParams: string[] = [];

      const operationParams = operation.parameters || [];
      const allParams = [...pathParams, ...operationParams];

      for (const param of allParams) {
        if ("$ref" in param) continue;

        const paramSchema = param.schema as OpenAPIV3.SchemaObject;
        properties[param.name] = {
          ...paramSchema,
          description: param.description,
          example: param.example,
        };

        if (param.required || param.in === "path") {
          requiredParams.push(param.name);
        }
      }

      const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
      if (requestBody?.content?.["application/json"]?.schema) {
        properties.body = {
          ...requestBody.content["application/json"].schema,
          description: requestBody.description,
        };
        if (requestBody.required) {
          requiredParams.push("body");
        }
      }

      tools.push({
        name: toolName,
        description:
          operation.description ||
          operation.summary ||
          `${method.toUpperCase()} ${path}`,
        inputSchema: {
          type: "object",
          properties,
          required: requiredParams.length > 0 ? requiredParams : undefined,
        },
      });
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }

      for (const [path, pathItem] of Object.entries(spec.paths)) {
        if (!pathItem) continue;
        for (const method of [
          "get",
          "put",
          "post",
          "delete",
          "patch",
        ] as const) {
          const operation = pathItem[method];
          if (!operation) continue;

          const currentToolName = generateToolName(path, method, operation);
          if (currentToolName === name) {
            let url = new URL(path, serverUrl);

            let pathName = url.pathname;
            Object.entries(args).forEach(([key, value]) => {
              if (pathName.includes(`{${key}}`)) {
                pathName = pathName.replace(`{${key}}`, String(value));
              }
            });
            url.pathname = pathName;

            Object.entries(args).forEach(([key, value]) => {
              if (!pathName.includes(`{${key}}`) && key !== "body") {
                url.searchParams.append(key, String(value));
              }
            });

            const headers: Record<string, string> = {
              Accept: "application/json",
              Authorization: process.env["NEXHEALTH_API_KEY"],
              "Nex-Api-Version": "v2",
            };

            const fetchOptions: RequestInit = {
              method: method.toUpperCase(),
              headers,
            };

            if (args.body) {
              headers["Content-Type"] = "application/json";
              fetchOptions.body = JSON.stringify(args.body);
            }

            const response = await fetch(url.toString(), fetchOptions);
            const responseData = await response.json();

            if (!response.ok) {
              console.error(JSON.stringify(responseData));
              throw new Error(`API call failed: ${response.statusText}`);
            }

            return {
              content: [
                { type: "text", text: JSON.stringify(responseData, null, 2) },
              ],
            };
          }
        }
      }

      throw new Error(`No implementation found for tool: ${name}`);
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stdin.resume();
}

async function main() {
  const { positionals } = parseArgs({
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    console.error("Usage: bunx oas-to-mcp <spec-url-or-path>");
    process.exit(1);
  }

  const specSource = positionals[0];
  const spec = await loadSpec(specSource);
  await startServer(spec);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
