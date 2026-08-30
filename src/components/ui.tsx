import {
  createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { popover, press, sheetBackdrop, sheetPanel, spring } from '../lib/motion';

/* ------------------------------------------------------------------ Button */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  trailingIcon?: string;
  block?: boolean;
}

export function Button({
  tone = 'secondary',
  size = 'md',
  icon,
  trailingIcon,
  block,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <motion.button
      whileTap={rest.disabled ? undefined : press}
      transition={spring}
      className={`btn btn-${tone} btn-${size} ${block ? 'btn-block' : ''} ${className}`}
      {...(rest as any)}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} size={size === 'sm' ? 15 : 17} />}
    </motion.button>
  );
}

/** Square icon-only button, used for chrome and row affordances. */
export function IconButton({
  icon, label, tone = 'ghost', size = 34, className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: string; label: string; tone?: ButtonTone; size?: number;
}) {
  return (
    <motion.button
      whileTap={press}
      transition={spring}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={`icon-btn icon-btn-${tone} ${className}`}
      {...(rest as any)}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </motion.button>
  );
}

/* -------------------------------------------------------------------- Card */

export function Card({
  className = '', children, padded = true, ...rest
}: { className?: string; children: ReactNode; padded?: boolean } & Record<string, any>) {
  return (
    <div className={`card ${padded ? 'card-pad' : ''} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHead({
  title, hint, action,
}: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <header className="card-head">
      <div>
        <h3 className="card-title">{title}</h3>
        {hint && <p className="card-hint">{hint}</p>}
      </div>
      {action}
    </header>
  );
}

/* --------------------------------------------------------------- Segmented */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
  accent?: string;
}

/** Sliding pill selector — the shared `layoutId` is what makes it glide. */
export function Segmented<T extends string>({
  options, value, onChange, size = 'md', name,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md' | 'lg';
  name?: string;
}) {
  const fallback = useId();
  const group = name ?? fallback;
  return (
    <div className={`segmented segmented-${size}`} role="tablist">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            className={`segment ${active ? 'is-active' : ''}`}
            style={active && option.accent ? ({ '--seg-accent': option.accent } as any) : undefined}
            onClick={() => onChange(option.value)}
          >
            {active && (
              <motion.span
                layoutId={`segment-${group}`}
                className="segment-pill"
                transition={spring}
              />
            )}
            <span className="segment-label">
              {option.icon && <Icon name={option.icon} size={size === 'sm' ? 14 : 16} />}
              <span className="segment-text">{option.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Fields */

export function Field({
  label, hint, error, children,
}: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
      <AnimatePresence>
        {error && (
          <motion.span
            className="field-error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            {error}
          </motion.span>
        )}
      </AnimatePresence>
    </label>
  );
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />;
}

/* ------------------------------------------------------------------ Select */

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  icon?: string;
  color?: string;
  group?: string;
  /** Renders one step in, as a child of the option above it. */
  child?: boolean;
  /**
   * The option this one sits under. Unlike `group` it starts no section — the
   * list stays in tree order — but it is searched, and stands in as the hint
   * once filtering has flattened the indent away.
   */
  under?: string;
  /**
   * A row that names a group rather than offering one: it is what the rows
   * under it belong to, and picking it would file something against a
   * heading. Shown, quietened, and inert.
   */
  heading?: boolean;
}

/** Custom listbox — the native one can't carry colour swatches or groups. */
export function Select({
  options, value, onChange, placeholder = 'Select…', disabled, allowClear, searchable,
  searchPlaceholder = 'Type to filter…',
}: {
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /** Puts a filter box at the top of the menu, for a long list. */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;

  // Each opening starts from the whole list, and the box takes the keys so
  // the filter is there the moment the menu is.
  useEffect(() => {
    if (!open) return setQuery('');
    if (!searchable) return;
    const focus = window.setTimeout(() => search.current?.focus(), 40);
    return () => window.clearTimeout(focus);
  }, [open, searchable]);

  // The menu is portalled to <body>, so the sheet's scroll container can never
  // clip it. That means measuring the trigger ourselves, and re-measuring on
  // any scroll or resize while it is open.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const node = root.current;
      if (node) setRect(node.getBoundingClientRect());
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.('.select-menu')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const term = query.trim().toLowerCase();
  const shown = term
    ? options.filter((o) =>
        `${o.label} ${o.hint ?? ''} ${o.group ?? ''} ${o.under ?? ''}`
          .toLowerCase()
          .includes(term),
      )
    : options;

  const groups = shown.reduce<Record<string, SelectOption[]>>((acc, o) => {
    const key = o.group ?? '';
    (acc[key] ??= []).push(o);
    return acc;
  }, {});

  const MENU_MAX = 268;
  // Flip above the trigger when the viewport below is too tight.
  const dropUp = !!rect && rect.bottom + MENU_MAX + 12 > window.innerHeight
    && rect.top > window.innerHeight - rect.bottom;

  const menu = rect && (
    <motion.div
      className="select-menu"
      variants={popover}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        ...(dropUp
          ? { bottom: window.innerHeight - rect.top + 6, transformOrigin: 'bottom center' }
          : { top: rect.bottom + 6, transformOrigin: 'top center' }),
        maxHeight: Math.min(
          MENU_MAX,
          (dropUp ? rect.top : window.innerHeight - rect.bottom) - 16,
        ),
      }}
    >
      {searchable && (
        <div className="select-search">
          <Icon name="search" size={14} />
          <input
            ref={search}
            value={query}
            placeholder={searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the first thing still standing, which after two or
              // three letters is almost always the one being looked for.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const first = shown[0];
              if (!first) return;
              onChange(first.value);
              setOpen(false);
            }}
          />
        </div>
      )}
      {allowClear && !term && (
        <button
          type="button"
          className="select-option"
          onClick={() => { onChange(null); setOpen(false); }}
        >
          <span className="swatch swatch-empty" />
          <span className="select-option-label">None</span>
        </button>
      )}
      {shown.length === 0 && <p className="select-empty">Nothing matches “{query.trim()}”.</p>}
      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="select-group">
          {group && <div className="select-group-label">{group}</div>}
          {items.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={option.heading}
              title={
                option.heading
                  ? `${option.label} is a group — pick one of the categories under it`
                  : undefined
              }
              className={`select-option ${option.value === value ? 'is-active' : ''} ${
                option.child && !term ? 'is-child' : ''
              } ${option.heading ? 'is-heading' : ''}`}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span
                className="swatch"
                style={{ background: option.color ?? 'var(--ink-3)' }}
              >
                {option.icon && <Icon name={option.icon} size={12} strokeWidth={2.2} />}
              </span>
              <span className="select-option-label">{option.label}</span>
              {(option.hint ?? (term ? option.under : null)) && (
                <span className="select-option-hint">{option.hint ?? option.under}</span>
              )}
              {option.value === value && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      ))}
    </motion.div>
  );

  return (
    <div className="select" ref={root}>
      <button
        type="button"
        className={`select-trigger ${open ? 'is-open' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <span className="select-value">
            <span
              className="swatch"
              style={{ background: selected.color ?? 'var(--ink-3)' }}
            >
              {selected.icon && <Icon name={selected.icon} size={12} strokeWidth={2.2} />}
            </span>
            {selected.label}
          </span>
        ) : (
          <span className="select-placeholder">{placeholder}</span>
        )}
        <Icon name="chevrons-up-down" size={15} className="select-caret" />
      </button>
      {createPortal(<AnimatePresence>{open && menu}</AnimatePresence>, document.body)}
    </div>
  );
}

/* ------------------------------------------------------------------- Sheet */

const SheetCtx = createContext<() => void>(() => {});
export const useSheetClose = () => useContext(SheetCtx);

/** Centred modal with a blurred scrim; Escape and scrim clicks both dismiss. */
export function Sheet({
  open, onClose, title, subtitle, children, footer, onBack, width = 520, full,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Set when the sheet is showing a page of its own: puts a way back in the
   *  header, where the title has already changed to say where you are. */
  onBack?: () => void;
  width?: number;
  /** Nearly the whole window, for work that is a table rather than a form. */
  full?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <SheetCtx.Provider value={onClose}>
          <motion.div
            className={`scrim ${full ? 'is-full' : ''}`}
            variants={sheetBackdrop}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          >
            <motion.div
              className={`sheet ${full ? 'is-full' : ''}`}
              style={full ? undefined : { maxWidth: width }}
              variants={sheetPanel}
              initial="initial"
              animate="animate"
              exit="exit"
              role="dialog"
              aria-modal="true"
              aria-label={title}
            >
              <header className="sheet-head">
                {onBack && (
                  <IconButton icon="chevron-left" label="Back" onClick={onBack} />
                )}
                {/* Keyed on the title, so moving between pages reads as a
                    change of place rather than text quietly swapping. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={title}
                    className="sheet-heading"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.14 }}
                  >
                    <h2 className="sheet-title">{title}</h2>
                    {subtitle && <p className="sheet-sub">{subtitle}</p>}
                  </motion.div>
                </AnimatePresence>
                <IconButton icon="x" label="Close" onClick={onClose} />
              </header>
              <div className="sheet-body">
                {/* The content is laid out at the width the sheet is heading
                    for, not the one it is passing through. A sheet that grows
                    a column would otherwise reflow at every width on the way —
                    two columns squeezed into six hundred pixels, wrapping down
                    the page — and lurch taller before settling back. */}
                <div
                  className="sheet-canvas"
                  style={
                    full
                      ? { width: '100%' }
                      : { width: `min(${width - 44}px, calc(100vw - 92px))` }
                  }
                >
                  {children}
                </div>
              </div>
              {footer && <footer className="sheet-foot">{footer}</footer>}
            </motion.div>
          </motion.div>
        </SheetCtx.Provider>
      )}
    </AnimatePresence>
  );
}

/* --------------------------------------------------------------- MoreMenu */

export interface MenuItem {
  icon: string;
  label: string;
  hint?: string;
  onClick: () => void;
}

/**
 * The quiet way to act on a row: one glyph that stays out of the way until
 * the pointer is over it, and a short list behind it. Rows have room for a
 * mark, not for a row of buttons — and a button that only appears on hover
 * is a button nobody knows the name of.
 */
export function MoreMenu({ items, label = 'More' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!items.length) return null;

  return (
    <div className={`more-menu ${open ? 'is-open' : ''}`} ref={root}>
      <button
        type="button"
        className="more-trigger"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((was) => !was);
        }}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="more-pop"
            variants={popover}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                className="more-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
              >
                <Icon name={item.icon} size={15} strokeWidth={2.1} />
                <span>
                  {item.label}
                  {item.hint && <em>{item.hint}</em>}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ Others */

export function Chip({
  active, onClick, children, color, count,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  color?: string;
  count?: number;
}) {
  return (
    <motion.button
      whileTap={press}
      transition={spring}
      className={`chip ${active ? 'is-active' : ''}`}
      style={active && color ? ({ '--chip-accent': color } as any) : undefined}
      onClick={onClick}
      type="button"
    >
      {color && <span className="chip-dot" style={{ background: color }} />}
      {children}
      {count !== undefined && <span className="chip-count">{count}</span>}
    </motion.button>
  );
}

export function Empty({
  icon = 'inbox', title, body, action,
}: { icon?: string; title: string; body?: string; action?: ReactNode }) {
  return (
    <motion.div
      className="empty"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <div className="empty-glyph">
        <Icon name={icon} size={22} />
      </div>
      <h4>{title}</h4>
      {body && <p>{body}</p>}
      {action}
    </motion.div>
  );
}

/** Thin animated bar used inside category and merchant lists. */
export function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="meter">
      <motion.span
        className="meter-fill"
        style={{ background: color }}
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
        transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
      />
    </div>
  );
}

/** Measures its child and animates the wrapper's height when it changes. */
export function AutoHeight({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');

  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(entry.contentRect.height),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  });

  return (
    <motion.div
      animate={{ height }}
      transition={spring}
      style={{ overflow: 'hidden' }}
    >
      <div ref={ref}>{children}</div>
    </motion.div>
  );
}
