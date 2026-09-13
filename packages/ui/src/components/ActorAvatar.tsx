import { useEffect, useState } from "react";
import { liveAvatarModel } from "../live-avatar.ts";

// One actor's face: the provider photo when the contract carries one, the
// author's initials when it does not. Lifted out of ReviewsPage when the Activity
// rail's Who panel needed the same thing — the circle, the image fallback, and
// the hover title are the behaviour, and having two copies of it would let them
// drift.
//
// The title is the whole point on a ranked chart: the footer under a bar is a few
// characters wide, so the account name is only recoverable by hovering.
export function ActorAvatar({
  login,
  avatarUrl,
  className,
  // See LiveAvatar: inside a rank chart the footer draws an instant CSS tip, so
  // the avatar must not add the browser's slow one on top of it.
  titled = true,
}: {
  login: string | null;
  avatarUrl?: string | null;
  className?: string;
  titled?: boolean;
}) {
  const model = liveAvatarModel(login ? { login, avatar_url: avatarUrl ?? null } : null);
  const [failed, setFailed] = useState(false);
  // A new URL deserves a fresh attempt; without this a single broken image would
  // pin the fallback for every actor that reuses the element.
  useEffect(() => setFailed(false), [model.imageUrl]);
  const showImage = model.imageUrl != null && !failed;
  const cls = `live-avatar ${showImage ? "live-avatar-image" : "live-avatar-text"}${className ? ` ${className}` : ""}`;
  return (
    <span className={cls} title={titled ? model.label : undefined} aria-label={model.label}>
      {showImage ? (
        <img src={model.imageUrl!} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="live-avatar-fallback" aria-hidden="true">{model.initials}</span>
      )}
    </span>
  );
}
