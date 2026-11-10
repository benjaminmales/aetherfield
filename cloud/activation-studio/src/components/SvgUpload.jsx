import { useCallback, useRef } from "react";
import "./SvgUpload.css";

export default function SvgUpload({ onMasterSvg, onIndividualSvg }) {
  const fileRef = useRef(null);

  const handleFiles = useCallback(
    (files) => {
      Array.from(files).forEach((file) => {
        if (!file.name.endsWith(".svg")) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target.result;
          const hasMasterGroups = (text.match(/<g\s+id="/g) || []).length >= 2;
          if (hasMasterGroups && files.length === 1) {
            onMasterSvg(text);
          } else {
            onIndividualSvg(text, file.name);
          }
        };
        reader.readAsText(file);
      });
    },
    [onMasterSvg, onIndividualSvg]
  );

  return (
    <div
      className="svg-upload"
      onDrop={(e) => {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => fileRef.current?.click()}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".svg"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="upload-icon" aria-hidden>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <div className="upload-text">Drop SVG here or click to browse</div>
      <div className="upload-sub">Master SVG with grouped layers (id) or single plan file</div>
    </div>
  );
}
