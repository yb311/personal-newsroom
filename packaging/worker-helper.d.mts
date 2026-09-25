export declare const WORKER_NAME: string;
export declare const WORKER_EXECUTABLE: string;
export declare const WORKER_BUNDLE_ID: string;
export declare function workerExecutable(frameworks: string): string;
export declare function makeWorkerHelper(frameworks: string, options?: { adhocSign?: boolean }): string;
