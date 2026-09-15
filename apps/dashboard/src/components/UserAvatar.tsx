const AVATAR_HUES = [210, 160, 25, 280, 340, 190, 45, 120] as const;

function hashUsername(username: string): number {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function initialsFromUsername(username: string): string {
  const parts = username.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  const cleaned = username.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length >= 2) return cleaned.slice(0, 2).toUpperCase();
  if (cleaned.length === 1) return cleaned.toUpperCase();
  return "?";
}

type UserAvatarProps = {
  username: string;
};

export function UserAvatar({ username }: UserAvatarProps) {
  const initials = initialsFromUsername(username);
  const hue = AVATAR_HUES[hashUsername(username) % AVATAR_HUES.length]!;
  const background = `hsl(${hue} 42% 42%)`;

  return (
    <span
      className="user-avatar"
      style={{ background }}
      role="img"
      aria-label={`${username} avatar`}
      title={username}
    >
      {initials}
    </span>
  );
}
