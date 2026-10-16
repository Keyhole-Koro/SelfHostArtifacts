/** Response bodies of the agent API (`/api/v1/*`), shared by the Worker and the CLI. */

export interface ApiError {
  error: { code: string; message: string };
}

export interface BlobCheckResponse {
  missing: string[];
}

export interface PublishResponse {
  id: string;
  url: string;
  version: number;
}

export interface ConflictError extends ApiError {
  error: { code: "version_conflict"; message: string };
  current_version: number;
}

export interface ArtifactSummary {
  id: string;
  url: string;
  title: string;
  description: string | null;
  version: number;
  updated_at: string;
  allow_connect: string[];
}

export interface ListResponse {
  artifacts: ArtifactSummary[];
}

export interface VersionFile {
  sha256: string;
  size: number;
  type: string;
}

export interface VersionSummary {
  version: number;
  entry: string;
  files: Record<string, VersionFile>;
  created_by: string;
  created_at: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  versions: VersionSummary[];
}

export interface PairStartResponse {
  code: string;
  approve_url: string;
  expires_at: string;
}

export type PairPollResponse =
  | { status: "pending" }
  | { status: "approved"; device_id: string }
  | { status: "denied" }
  | { status: "expired" };
