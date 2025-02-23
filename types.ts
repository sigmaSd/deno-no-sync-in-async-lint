
export interface FunctionInfo {
  isBlocking: boolean;
  containsSync: boolean;
  callsBlocking: Set<string>;
  location: {
    file: string;
  };
}

export interface ImportInfo {
  source: string;
  imports: Map<string, string>; // local => original name
  exports: Map<string, string>;
}

export interface FileAnalysis {
  functions: Map<string, FunctionInfo>;
  imports: ImportInfo[];
}

export interface ProgramAnalysis {
  files: Map<string, FileAnalysis>;
  blockingFunctions: Set<string>;
}
