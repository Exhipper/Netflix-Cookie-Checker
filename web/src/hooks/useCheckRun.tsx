import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import createContextHook from "@nkzw/create-context-hook";
import {
  startCheck,
  subscribeToRun,
  cancelRun,
  type ProgressUpdate,
  type AppConfig,
} from "@/lib/api";

export interface PukeFile {
  name: string;
  content: string;
  size: number;
}

export interface CheckRunState {
  isRunning: boolean;
  runId: string | null;
  progress: ProgressUpdate | null;
  liveResults: ProgressUpdate[];
  pukes: PukeFile[];
  proxyText: string;
  threads: number;
  config: AppConfig | null;
  error: string | null;
}

function useCheckRunState() {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [liveResults, setLiveResults] = useState<ProgressUpdate[]>([]);
  const [pukes, setPukes] = useState<PukeFile[]>([]);
  const [proxyText, setProxyText] = useState<string>("");
  const [threads, setThreads] = useState<number>(30);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Clean up EventSource on unmount (only the provider unmounts = app teardown)
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const start = useCallback(
    async (
      pukeFiles: PukeFile[],
      proxy: string,
      cfg: AppConfig | Partial<AppConfig>,
      threadCount: number
    ): Promise<{ runId: string; total: number; threads: number }> => {
      // Close any existing EventSource
      eventSourceRef.current?.close();
      eventSourceRef.current = null;

      setPukes(pukeFiles);
      setProxyText(proxy);
      setThreads(threadCount);
      setLiveResults([]);
      setProgress(null);
      setError(null);
      setIsRunning(true);

      try {
        const result = await startCheck(
          pukeFiles.map((c) => ({ name: c.name, content: c.content })),
          proxy,
          cfg,
          threadCount
        );
        setRunId(result.runId);
        setConfig(cfg as AppConfig);

        const es = subscribeToRun(result.runId, (update) => {
          if (update.type === "result") {
            setProgress(update);
            setLiveResults((prev) => [update, ...prev].slice(0, 100));
          } else if (update.type === "progress") {
            setProgress(update);
          } else if (update.type === "complete") {
            setProgress(update);
            setIsRunning(false);
            eventSourceRef.current?.close();
            eventSourceRef.current = null;
          } else if (update.type === "error") {
            setError(update.message || "Check failed");
            setIsRunning(false);
            eventSourceRef.current?.close();
            eventSourceRef.current = null;
          }
        });
        eventSourceRef.current = es;

        return result;
      } catch (err: any) {
        setError(err.message || "Failed to start check");
        setIsRunning(false);
        throw err;
      }
    },
    []
  );

  const cancel = useCallback(async () => {
    if (runId) {
      await cancelRun(runId).catch(() => {});
      setIsRunning(false);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    }
  }, [runId]);

  const reset = useCallback(() => {
    setRunId(null);
    setProgress(null);
    setLiveResults([]);
    setError(null);
    setIsRunning(false);
  }, []);

  return {
    isRunning,
    runId,
    progress,
    liveResults,
    pukes,
    proxyText,
    threads,
    config,
    error,
    start,
    cancel,
    reset,
    setThreads,
    setConfig,
  };
}

const [CheckRunProvider, useCheckRun] = createContextHook(useCheckRunState);

export { CheckRunProvider, useCheckRun };
