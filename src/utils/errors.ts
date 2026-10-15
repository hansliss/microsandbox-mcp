import { errorResult, type ToolResult } from "./response.js";
import { ImagePolicyError, PolicyError, formatPolicyError } from "./policy.js";

export function formatError(error: unknown): ToolResult {
  if (error instanceof ImagePolicyError) return errorResult(error, error.code);
  if (error instanceof PolicyError) {
    return formatPolicyError(error);
  }

  return errorResult(error);
}
