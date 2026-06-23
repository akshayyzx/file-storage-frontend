import {
  CheckCircle2,
  Cloud,
  FileArchive,
  Loader2,
  PauseCircle,
  RotateCcw,
  UploadCloud,
  Wifi,
} from "lucide-react";
import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

const DEFAULT_API_BASE_URL = "http://localhost:5000/api/upload";

function normalizeApiBaseUrl(rawBaseUrl?: string) {
  const baseUrl = (rawBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");

  if (/\/api\/upload$/i.test(baseUrl) || /\/upload$/i.test(baseUrl)) {
    return baseUrl;
  }

  if (/\/api$/i.test(baseUrl)) {
    return `${baseUrl}/upload`;
  }

  return `${baseUrl}/api/upload`;
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const CHUNK_SIZE = 5 * 1024 * 1024;

type UploadPhase = "idle" | "initializing" | "uploading" | "completing" | "completed" | "error";

type UploadedPart = {
  partNumber: number;
  etag: string;
};

type UploadStatus = {
  uploadId: string;
  fileName: string;
  totalChunks: number;
  uploadedParts: UploadedPart[];
  status: string;
};

type InitializeResponse = {
  success: boolean;
  uploadId: string;
  s3UploadId: string;
  message?: string;
};

type StatusResponse = {
  success: boolean;
  data: UploadStatus;
  message?: string;
};

function formatBytes(value: number) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;

  return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function uploadChunk({
  uploadId,
  partNumber,
  chunk,
  onProgress,
}: {
  uploadId: string;
  partNumber: number;
  chunk: Blob;
  onProgress: (loaded: number) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const formData = new FormData();
    formData.append("partNumber", String(partNumber));
    formData.append("chunk", chunk);

    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE_URL}/${uploadId}/chunk`);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(chunk.size);
        resolve();
        return;
      }

      reject(new Error(`Chunk ${partNumber} failed with status ${request.status}`));
    };

    request.onerror = () => reject(new Error(`Network error while uploading chunk ${partNumber}`));
    request.send(formData);
  });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await readJsonResponse<T & { message?: string; success?: boolean }>(
    response,
    `Request to ${response.url} failed`
  );

  if (!response.ok || payload.success === false) {
    throw new Error(payload.message ?? "Request failed");
  }

  return payload;
}

async function getStatus(uploadId: string) {
  const response = await fetch(`${API_BASE_URL}/status/${uploadId}`);
  const payload = await readJsonResponse<StatusResponse>(
    response,
    `Unable to fetch upload status from ${response.url}`
  );

  if (!response.ok || payload.success === false) {
    throw new Error(payload.message ?? "Unable to fetch upload status");
  }

  return payload.data;
}

async function readJsonResponse<T extends { message?: string; success?: boolean }>(
  response: Response,
  fallbackMessage: string
) {
  const contentType = response.headers.get("content-type") ?? "";
  const rawPayload = await response.text();

  if (!contentType.includes("application/json")) {
    throw new Error(
      `${fallbackMessage}: expected JSON but received ${
        contentType || "an unknown content type"
      }. Check VITE_API_BASE_URL.`
    );
  }

  try {
    return JSON.parse(rawPayload) as T;
  } catch {
    throw new Error(`${fallbackMessage}: server returned invalid JSON.`);
  }
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [uploadId, setUploadId] = useState("");
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [activeChunkBytes, setActiveChunkBytes] = useState(0);
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [message, setMessage] = useState("Choose a file to begin");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const totalChunks = file ? Math.ceil(file.size / CHUNK_SIZE) : 0;
  const liveBytes = Math.min((file?.size ?? 0), uploadedBytes + activeChunkBytes);
  const progress = file ? Math.round((liveBytes / file.size) * 100) : 0;
  const backendProgress = status
    ? Math.round((status.uploadedParts.length / status.totalChunks) * 100)
    : 0;

  const details = useMemo(
    () => [
      { label: "File size", value: file ? formatBytes(file.size) : "No file" },
      { label: "Chunks", value: totalChunks ? `${uploadedChunks}/${totalChunks}` : "0/0" },
      { label: "Backend", value: status ? `${backendProgress}% confirmed` : "Waiting" },
      { label: "API", value: API_BASE_URL.replace(/^https?:\/\//, "") },
    ],
    [backendProgress, file, status, totalChunks, uploadedChunks]
  );

  function resetUpload() {
    setFile(null);
    setPhase("idle");
    setUploadId("");
    setUploadedBytes(0);
    setActiveChunkBytes(0);
    setUploadedChunks(0);
    setStatus(null);
    setMessage("Choose a file to begin");
    setError("");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function selectFile(nextFile: File | null) {
    if (!nextFile) {
      return;
    }

    setFile(nextFile);
    setPhase("idle");
    setUploadId("");
    setUploadedBytes(0);
    setActiveChunkBytes(0);
    setUploadedChunks(0);
    setStatus(null);
    setError("");
    setMessage(`${nextFile.name} is ready`);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function refreshStatus(nextUploadId: string) {
    const nextStatus = await getStatus(nextUploadId);
    setStatus(nextStatus);
    setUploadedChunks(nextStatus.uploadedParts.length);
    return nextStatus;
  }

  async function startUpload() {
    if (!file || phase === "uploading" || phase === "initializing") {
      return;
    }

    try {
      setError("");
      setPhase("initializing");
      setMessage("Creating multipart upload");

      const initialized = await postJson<InitializeResponse>("/initialize", {
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
      });

      setUploadId(initialized.uploadId);
      setMessage("Uploading chunks");
      setPhase("uploading");

      let confirmedBytes = 0;

      for (let index = 0; index < totalChunks; index += 1) {
        const partNumber = index + 1;
        const start = index * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        setMessage(`Uploading chunk ${partNumber} of ${totalChunks}`);
        setActiveChunkBytes(0);

        await uploadChunk({
          uploadId: initialized.uploadId,
          partNumber,
          chunk,
          onProgress: setActiveChunkBytes,
        });

        confirmedBytes += chunk.size;
        setUploadedBytes(confirmedBytes);
        setActiveChunkBytes(0);
        await refreshStatus(initialized.uploadId);
      }

      setPhase("completing");
      setMessage("Finalizing upload");
      await postJson("/complete", { uploadId: initialized.uploadId });
      await refreshStatus(initialized.uploadId);
      setUploadedBytes(file.size);
      setUploadedChunks(totalChunks);
      setPhase("completed");
      setMessage("Upload completed");
    } catch (uploadError) {
      setPhase("error");
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
      setMessage("Upload needs attention");
    }
  }

  const isBusy = phase === "initializing" || phase === "uploading" || phase === "completing";
  const canUpload = Boolean(file) && !isBusy && phase !== "completed";

  return (
    <main className="app-shell">
      <section className="workspace">
        <div className="panel upload-panel">
          <div className="eyebrow">
            <Wifi size={16} />
            Live multipart transfer
          </div>

          <div className="headline-row">
            <div>
              <h1>Upload Console</h1>
              <p>Stream large files through the backend with real-time progress.</p>
            </div>
            <button className="icon-button" type="button" onClick={resetUpload} title="Reset upload">
              <RotateCcw size={20} />
            </button>
          </div>

          <label
            className={`drop-zone ${isDragging ? "is-dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <input ref={inputRef} type="file" onChange={handleFileChange} />
            <span className="drop-icon">
              <UploadCloud size={30} />
            </span>
            <span className="drop-title">{file ? file.name : "Drop your file here"}</span>
            <span className="drop-meta">
              {file ? `${formatBytes(file.size)} in ${totalChunks} chunks` : "or click to browse"}
            </span>
          </label>

          <div className="action-row">
            <button className="primary-button" type="button" onClick={startUpload} disabled={!canUpload}>
              {isBusy ? <Loader2 className="spin" size={20} /> : <Cloud size={20} />}
              {phase === "completed" ? "Completed" : isBusy ? "Uploading" : "Start upload"}
            </button>
            <div className={`status-pill status-${phase}`}>
              {phase === "completed" ? <CheckCircle2 size={17} /> : <PauseCircle size={17} />}
              {message}
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
        </div>

        <aside className="panel progress-panel">
          <div className="progress-header">
            <div>
              <span className="muted-label">Progress</span>
              <strong>{progress}%</strong>
            </div>
            <FileArchive size={26} />
          </div>

          <div className="progress-ring" style={{ "--progress": `${progress}%` } as React.CSSProperties}>
            <div>
              <span>{progress}%</span>
              <small>{formatBytes(liveBytes)} sent</small>
            </div>
          </div>

          <div className="bar-track">
            <span style={{ width: `${progress}%` }} />
          </div>

          <div className="detail-grid">
            {details.map((detail) => (
              <div className="detail-card" key={detail.label}>
                <span>{detail.label}</span>
                <strong>{detail.value}</strong>
              </div>
            ))}
          </div>

          <div className="timeline">
            <div className={phase !== "idle" ? "done" : ""}>Initialized</div>
            <div className={uploadedChunks > 0 ? "done" : ""}>Chunks streaming</div>
            <div className={phase === "completed" ? "done" : ""}>S3 completed</div>
          </div>
        </aside>
      </section>
    </main>
  );
}
