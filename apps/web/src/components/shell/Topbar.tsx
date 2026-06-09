import * as I from "@/components/icons";

export interface TopbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  username: string;
  hideSearch?: boolean;
}

export function Topbar({ searchValue, onSearchChange, username, hideSearch }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <div className="mark"><I.Skiff size={14} /></div>
        <span className="name">Skiff</span>
        <span className="v">v0.2</span>
      </div>

      {!hideSearch ? (
        <div className="topbar__search">
          <I.Search size={13} />
          <input
            type="text"
            placeholder="Search hosts…"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          <span className="kbd">/</span>
        </div>
      ) : <div />}

      <div className="topbar__actions">
        <div className="topbar__user">
          <div className="avatar">{username[0]?.toUpperCase() ?? "A"}</div>
          <span className="who">{username}</span>
        </div>
      </div>
    </header>
  );
}
