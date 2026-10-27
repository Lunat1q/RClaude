import { useEffect, useState } from "react";
import { api, shortPath } from "../api";

interface Listing {
  path: string;
  parent: string | null;
  dirs: string[];
}

export function DirPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");

  const load = (path: string) => {
    setError("");
    api<Listing>(`/fs/dirs?path=${encodeURIComponent(path)}`).then(
      (l) => {
        setListing(l);
        onChange(l.path);
      },
      (e) => setError(e.message),
    );
  };

  useEffect(() => load(value), []); // eslint-disable-line react-hooks/exhaustive-deps

  const mkdir = async () => {
    if (!listing || !newName.trim()) return;
    try {
      const { path } = await api<{ path: string }>("/fs/mkdir", { body: { parent: listing.path, name: newName.trim() } });
      setNewName("");
      load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="dirpicker">
      <div className="dirpicker-path">
        <button type="button" className="btn small" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
          ↑ Up
        </button>
        <code title={listing?.path}>
          <span>{shortPath(listing?.path) || "…"}</span>
        </code>
      </div>
      <div className="dirpicker-list">
        {listing?.dirs.map((d) => (
          <button type="button" key={d} className="dir" onClick={() => load(`${listing.path}/${d}`)}>
            📁 {d}
          </button>
        ))}
        {listing && listing.dirs.length === 0 && <div className="muted small pad">No subfolders</div>}
      </div>
      <div className="dirpicker-new">
        <input placeholder="New folder name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="button" className="btn small" onClick={mkdir} disabled={!newName.trim()}>
          Create
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
