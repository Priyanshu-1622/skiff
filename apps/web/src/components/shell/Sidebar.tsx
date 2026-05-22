import { useState } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import * as I from "@/components/icons";

interface SidebarFolder {
  id: string;
  name: string;
  count: number;
  children?: SidebarFolder[];
}

export interface SidebarProps {
  totalHosts?: number;
  favoritesCount?: number;
  folders?: SidebarFolder[];
  activeFolderId?: string | null;
  onSelectFolder?: (id: string | null) => void;
  onAddFolder?: () => void;
  onDeleteFolder?: (id: string) => void;
  vault?: { unlocked: boolean; idleMinutes: number };
  onVaultClick?: () => void;
}

export function Sidebar({
  totalHosts = 0,
  favoritesCount = 0,
  folders = [],
  activeFolderId = null,
  onSelectFolder = () => {},
  onAddFolder,
  onDeleteFolder,
  vault,
  onVaultClick,
}: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isDash = location.pathname === "/";

  return (
    <aside className="sidebar">
      <nav>
        <button
          type="button"
          className="nav-item"
          aria-current={isDash && !activeFolderId ? "true" : undefined}
          onClick={() => { onSelectFolder(null); navigate({ to: "/" }); }}
        >
          <span className="icon"><I.Server size={14} /></span>
          All hosts
          <span className="count">{totalHosts}</span>
        </button>

        <button
          type="button"
          className="nav-item"
          aria-current={activeFolderId === "__starred" ? "true" : undefined}
          onClick={() => { onSelectFolder("__starred"); navigate({ to: "/" }); }}
        >
          <span className="icon"><I.Star size={14} /></span>
          Favorites
          <span className="count">{favoritesCount}</span>
        </button>

        <button
          type="button"
          className="nav-item"
          aria-current={location.pathname === "/settings" ? "true" : undefined}
          onClick={() => navigate({ to: "/settings" })}
        >
          <span className="icon"><I.Settings size={14} /></span>
          Settings
        </button>
      </nav>

      <div className="sidebar__group">
        <span>Folders</span>
        {onAddFolder && (
          <button type="button" className="add" onClick={onAddFolder} title="New folder">
            <I.Plus size={10} />
          </button>
        )}
      </div>
      {folders.length > 0 ? (
        folders.map((f) => (
          <FolderItem
            key={f.id}
            folder={f}
            active={activeFolderId === f.id}
            onSelect={onSelectFolder}
            onDelete={onDeleteFolder}
          />
        ))
      ) : (
        <div className="sidebar__folders-empty">
          <div className="strong">No folders yet</div>
          Click + to create one.
        </div>
      )}

      <div className="sidebar__foot">
        <div
          className="vault-status"
          onClick={onVaultClick}
          style={{ cursor: onVaultClick ? "pointer" : "default" }}
        >
          <div className={`dot${vault && !vault.unlocked ? " is-locked" : ""}`} />
          <div className="meta">
            <div className="l1">{vault?.unlocked ? "Vault unlocked" : "Vault locked"}</div>
            {vault?.unlocked && (
              <div className="l2">locks after {vault.idleMinutes}min idle</div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function FolderItem({
  folder,
  active,
  onSelect,
  onDelete,
}: {
  folder: SidebarFolder;
  active: boolean;
  onSelect: (id: string | null) => void;
  onDelete?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasChildren = folder.children && folder.children.length > 0;

  return (
    <>
      <div
        className="tree-item"
        aria-current={active ? "true" : undefined}
        onClick={() => onSelect(folder.id)}
      >
        <span
          className={`twist${hasChildren ? (open ? " open" : "") : " empty"}`}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <I.Chevron size={10} />
        </span>
        <span className="icon"><I.Folder size={12} /></span>
        <span className="label">{folder.name}</span>
        <span className="count">{folder.count}</span>
        {onDelete && (
          <button
            type="button"
            className="tree-item__delete"
            onClick={(e) => { e.stopPropagation(); onDelete(folder.id); }}
            title="Delete folder"
            aria-label="Delete folder"
          >
            <I.Close size={10} />
          </button>
        )}
      </div>
      {open && hasChildren && folder.children!.map((child) => (
        <div key={child.id} style={{ marginLeft: 16 }}>
          <FolderItem folder={child} active={active} onSelect={onSelect} />
        </div>
      ))}
    </>
  );
}
