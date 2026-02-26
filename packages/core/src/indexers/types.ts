export interface IndexResult {
  scipFilePath: string;
  language: string;
  filesIndexed: number;
  errors: string[];
  duration: number;
}

export interface Indexer {
  name: string;
  canIndex(repoRoot: string): boolean;
  run(
    repoRoot: string,
    opts?: { targetDir?: string; projectId?: string },
  ): IndexResult;
}
