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
  /** The project it belongs to, or null. */
  project: string | null;
  /** The page above it in its project's tree, or null at the top. */
  parent: string | null;
  /** Its place among the pages with the same parent, from 1. */
  position: number;
  labels: string[];
  /** Who may see and change it, beyond its project's rules: only some may edit, or only some may view. */
  restriction: "edit" | "view" | null;
  version: number;
  updated_at: string;
  allow_connect: string[];
}

export interface ListResponse {
  artifacts: ArtifactSummary[];
}

export interface ProjectCount {
  /** null for pages without a project. */
  project: string | null;
  count: number;
}

export interface ProjectListResponse {
  projects: ProjectCount[];
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

export interface LinkSummary {
  id: string;
  url: string;
  title: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  versions: VersionSummary[];
  /** Pages whose current version links to this one. */
  linked_from: LinkSummary[];
  /** Pages this one's current version links to. */
  links_to: LinkSummary[];
}

export interface SearchResult {
  id: string;
  url: string;
  title: string;
  project: string | null;
  updated_at: string;
  /** Text around the match; the matched words are between [[ and ]]. For a match by meaning, the passage that matched. */
  snippet: string;
  /** words: it has the words; meaning: it says something close in other words; both. */
  match: "words" | "meaning" | "both";
}

export interface SearchResponse {
  results: SearchResult[];
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

/** PATCH /api/v1/artifacts/:id: move a page without making a version. */
export interface MoveRequest {
  /** Another project (null: none). The pages under it move along, and it goes to the top. */
  project?: string | null;
  /** The page to go under, in the same project (null: the top). */
  parent?: string | null;
  /** Its place among its siblings, from 1. */
  position?: number;
}

export interface MoveResponse {
  id: string;
  project: string | null;
  parent: string | null;
  position: number;
}

export interface CommentSummary {
  id: string;
  /** The thread's first comment, for a reply; null for a thread's first comment. */
  reply_to: string | null;
  author: string;
  /** Written by an agent (a device), not a person. */
  by_agent: boolean;
  body: string;
  /** The passage of the page it is about; null for the whole page. */
  quote: string | null;
  /** The version it was written on. */
  version: number;
  /** For a thread's first comment: whether the thread is settled. */
  resolved: boolean;
  created_at: string;
}

export interface CommentListResponse {
  comments: CommentSummary[];
}

/** POST /api/v1/artifacts/:id/comments */
export interface CommentRequest {
  body: string;
  /** Reply in this thread (the id of its first comment). */
  reply_to?: string;
  /** A passage of the page, for a new thread about it. */
  quote?: string;
  /** With reply_to: settle the thread after replying. */
  resolve?: boolean;
}

export interface ActivityItem {
  at: string;
  kind: "created" | "updated" | "commented" | "replied" | "resolved";
  /** Who did it; by_agent when it was an agent's device. */
  actor: string;
  by_agent: boolean;
  page: { id: string; url: string; title: string; project: string | null };
  version: number | null;
  /** The comment it is about (for a reply, its thread). */
  comment_id: string | null;
}

export interface ActivityResponse {
  activity: ActivityItem[];
}

/** Changes a page's labels: `set` replaces them all; otherwise `add` and `remove`. */
export interface LabelRequest {
  set?: string[];
  add?: string[];
  remove?: string[];
}

export interface LabelResponse {
  id: string;
  labels: string[];
}
