// URL is a global wherever this package runs (Node, Workers, browsers); only what text.ts uses.
declare class URL {
  constructor(url: string, base?: string | URL);
  readonly host: string;
  readonly pathname: string;
}
