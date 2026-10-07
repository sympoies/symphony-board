import { linkSource, profileIndex, type EntityDestination } from "../entity-links.ts";
import { createContext, useContext, useMemo, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { useViewportMenu } from "./useViewportMenu.ts";
import type { ContractEnvelope } from "@symphony-board/contract";
import { externalWebUrl, providerEntityUrl, type ProviderEntity, type ProviderLinkSource } from "../../../../shared/provider-links.ts";

const Sources = createContext<ReadonlyMap<string, ProviderLinkSource>>(new Map());
const Repositories = createContext<readonly { source_id: string; project_path: string | null }[]>([]);
const Profiles = createContext<ReadonlyMap<string, string>>(new Map());

export function ProviderLinks({ env, children }: { env: ContractEnvelope | null; children: ReactNode }) {
  const sources = useMemo(() => new Map((env?.sources ?? []).map(s => [s.source_id, s])), [env?.sources]);
  const profiles = useMemo(() => profileIndex(env?.repo_metrics ?? []), [env?.repo_metrics]);
  const repos = useMemo(() => [...(env?.repo_stats ?? []), ...(env?.repo_metrics ?? []), ...(env?.items ?? [])], [env?.repo_stats, env?.repo_metrics, env?.items]);
  return <Sources.Provider value={sources}><Profiles.Provider value={profiles}><Repositories.Provider value={repos}>{children}</Repositories.Provider></Profiles.Provider></Sources.Provider>;
}

export function useLinkSource(sourceId?: string | null): ProviderLinkSource | null {
  const sources = useContext(Sources);
  return linkSource(sourceId, sources);
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href?: string | null };
export function ExternalLink({ href, children, className = "", onClick, onKeyDown, ...props }: LinkProps) {
  const safe = href?.startsWith("mailto:") ? href : externalWebUrl(href);
  if (!safe) {
    const { target: _target, rel: _rel, download: _download, ...presentation } = props;
    return <span {...presentation as HTMLAttributes<HTMLSpanElement>} className={className}>{children}</span>;
  }
  return <a aria-description="Opens in a new tab" {...props} className={`external-link ${className}`.trim()} href={safe} target="_blank" rel="noopener noreferrer"
    onClick={event => { event.stopPropagation(); onClick?.(event); }}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); onKeyDown?.(event); }}>{children}</a>;
}

export function EntityLink({ sourceId, source, entity, ...props }: Omit<LinkProps, "href"> & {
  sourceId?: string | null; source?: ProviderLinkSource; entity: ProviderEntity;
}) {
  const configured = useLinkSource(sourceId);
  return <ExternalLink {...props} href={providerEntityUrl(source ?? configured, entity)} />;
}

// An activity's commit author can be a display name, not a provider username.
// Use observed/profile-directory URLs there; only provider account fields may
// request username reconstruction.
export function ActorLink({ sourceId, name, url, username = false, ...props }: Omit<LinkProps, "href"> & {
  sourceId?: string | null; name: string | null; url?: string | null; username?: boolean;
}) {
  const profiles = useContext(Profiles);
  return <EntityLink {...props} sourceId={sourceId} entity={{ kind: "profile", username: username ? name : null,
    url: url ?? profiles.get(`${sourceId}|${name}`) }} />;
}

// Shared adapter for existing internal drilldowns that sometimes fall back to
// a provider URL. Internal routes retain same-tab navigation.
export function NavigationLink({ href, ...props }: LinkProps) {
  return href?.startsWith("#/") ? <a {...props} href={href} /> : <ExternalLink {...props} href={href} />;
}

// A single destination links the name directly. An aggregate shared by several
// repos/accounts offers their qualified destinations in a keyboard-openable
// disclosure; it never silently chooses one provider or repository.
export function RankEntityLabel({ label, entities, children, className = "live-rank-name" }: { label: string; entities: EntityDestination[]; children?: ReactNode; className?: string }) {
  const sources = useContext(Sources);
  const profiles = useContext(Profiles);
  const [open, setOpen] = useState(false);
  const menuRef = useViewportMenu(open, entities);
  const links = new Map<string, string>();
  for (const candidate of entities) {
    const entity = candidate.entity;
    const url = providerEntityUrl(linkSource(candidate.sourceId, sources), entity.kind === "profile"
      ? { ...entity, url: entity.url ?? profiles.get(`${candidate.sourceId}|${label}`) } : entity);
    if (url) links.set(url, candidate.label);
  }
  const destinations = [...links.entries()];
  const body = children ?? label;
  if (destinations.length === 0) return <span className={className}>{body}</span>;
  if (destinations.length === 1) return <ExternalLink className={className} href={destinations[0]![0]} aria-label={`Open ${label} on provider`}>{body}</ExternalLink>;
  return <details className="rank-entity-menu" onToggle={event => setOpen(event.currentTarget.open)} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
    <summary className={className} aria-label={`Choose provider destination for ${label}`}>{body}{children === "↗" ? null : " ↗"}</summary>
    <div ref={menuRef} className="rank-entity-destinations">{destinations.map(([href, name]) => <ExternalLink key={href} href={href}>{name}</ExternalLink>)}</div>
  </details>;
}

// Filter values can be repo paths mirrored on several sources. Match only
// repositories actually present in the contract, then use the same disclosure
// as ranked labels when more than one destination exists.
export function RepoReference({ path, children }: { path: string; children?: ReactNode }) {
  const repos = useContext(Repositories);
  return <RankEntityLabel label={path} entities={repos.filter(repo => repo.project_path === path).map(repo => ({ sourceId: repo.source_id, entity: { kind: "repo", projectPath: path }, label: `${path} · ${repo.source_id}` }))}>{children}</RankEntityLabel>;
}

// Keeps outbound controls outside the native selection button. Callers retain
// their established grid class and callback; outbound clicks never select.
export function SelectableEntityRow({ children, className, label, selected, onSelect }: {
  children: ReactNode; className: string; label: string; selected: boolean; onSelect: () => void;
}) {
  return <div className={`${className} selectable-entity-row`}>
    <button type="button" className="entity-row-select" aria-label={label} aria-pressed={selected} onClick={onSelect} />
    {children}
  </div>;
}
