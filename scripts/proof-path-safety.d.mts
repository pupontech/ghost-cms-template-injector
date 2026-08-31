export interface ProofPaths {
  cookieJar: string;
  evidenceDirectory: string;
}

export declare function resolveProofPaths(
  repositoryRoot: string,
  cookieJarInput: string,
): ProofPaths;

export declare function writeProofArtifact(
  repositoryRoot: string,
  evidenceDirectory: string,
  filename: string,
  content: string,
): string;
