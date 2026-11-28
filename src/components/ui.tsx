import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef,
  useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { EmptyArt, type EmptyArtName } from './EmptyArt';
import { Icon } from './Icon';
import {
  emptyArt, emptyLine, emptyStack, popover, press, sheetBackdrop, sheetPanel, sheetPhone,
  spring, springSoft,
} from '../lib/motion';
import { usePhone } from '../lib/media';
import { holdNativeTabs } from '../lib/nativeTabs';

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

export function TextInput({
  className = '', ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  // `ref` rides in with the rest of the props: a function component takes it
  // as one, and a caller that wants to put the cursor in the field it has
  // just revealed needs to reach the input itself.
  return <input className={`input ${className}`} {...rest} />;
}

/**
 * A field that can run to several lines. It grows with what is typed rather
 * than scrolling inside a fixed box — a note worth writing is worth being able
 * to see all of while you write it.
 */
export function TextArea({
  className = '', value, ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Measured after every change: reset to nothing first, or scrollHeight only
  // ever reports the height it already has and the box can never shrink back.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea ref={ref} rows={1} value={value} className={`input textarea ${className}`} {...rest} />
  );
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
  searchPlaceholder = 'Type to filter…', clearLabel = 'None', menuWidth,
}: {
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /** What emptying it means here, where "None" is not the whole story — a
   *  template's blank field is a question it means to ask, not an absence. */
  clearLabel?: string;
  /** Puts a filter box at the top of the menu, for a long list. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** The least the menu may be across, for options too long for the trigger. */
  menuWidth?: number;
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
        ...(() => {
          const width = Math.min(Math.max(rect.width, menuWidth ?? 0), window.innerWidth - 16);
          return { width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) };
        })(),
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
          <span className="select-option-label">{clearLabel}</span>
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
                  ? `${option.label} is a group. Pick one of the categories under it`
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

/* -------------------------------------------------------------- OptionRail */

/**
 * The same options a Select would hold, laid out end to end and scrolled
 * sideways instead of opened. For a short list picked from constantly — the
 * accounts on a transaction — where a menu costs two clicks to say what a row
 * of chips says at a glance.
 *
 * The ends fade rather than cut, and each side only fades while there is
 * something past it: a hard edge on a row that has stopped scrolling reads as
 * a cut-off name.
 */
export function OptionRail({
  options, value, onChange, allowClear, clearLabel = 'None',
  empty = 'Nothing to choose from.',
}: {
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Offers a leading chip for choosing nothing. */
  allowClear?: boolean;
  clearLabel?: string;
  empty?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const node = track.current;
    if (!node) return;
    const max = node.scrollWidth - node.clientWidth;
    setFade((was) => {
      const left = node.scrollLeft > 1;
      const right = node.scrollLeft < max - 1;
      return was.left === left && was.right === right ? was : { left, right };
    });
  }, []);

  // The row is measured against its own width, which the sheet changes as it
  // grows a column — so watch the element, not just the list.
  useLayoutEffect(() => {
    const node = track.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, options.length]);

  // Chosen from somewhere other than the row — swapped round, or filled in by
  // a template — so bring it into view rather than leaving the scroll where
  // the last hand left it.
  useEffect(() => {
    const node = track.current;
    if (!node || !value) return;
    const chip = node.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`);
    if (!chip) return;
    const near = chip.offsetLeft - 16;
    const far = chip.offsetLeft + chip.offsetWidth + 16 - node.clientWidth;
    if (near < node.scrollLeft) node.scrollTo({ left: Math.max(0, near), behavior: 'smooth' });
    else if (far > node.scrollLeft) node.scrollTo({ left: far, behavior: 'smooth' });
  }, [value]);

  return (
    <div className={`rail ${fade.left ? 'is-fade-left' : ''} ${fade.right ? 'is-fade-right' : ''}`}>
      <div className="rail-track" ref={track} onScroll={measure} role="radiogroup">
        {allowClear && (
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            className={`rail-chip ${value === null ? 'is-active' : ''}`}
            onClick={() => onChange(null)}
          >
            <span className="swatch swatch-empty" />
            <span className="rail-chip-label">{clearLabel}</span>
          </button>
        )}
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            data-value={option.value}
            title={option.hint ? `${option.label} · ${option.hint}` : option.label}
            style={{ '--chip-accent': option.color } as CSSProperties}
            className={`rail-chip ${option.value === value ? 'is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <span className="swatch" style={{ background: option.color ?? 'var(--ink-3)' }}>
              {option.icon && <Icon name={option.icon} size={12} strokeWidth={2.2} />}
            </span>
            <span className="rail-chip-label">{option.label}</span>
          </button>
        ))}
        {options.length === 0 && !allowClear && <p className="rail-empty">{empty}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Sheet */

const SheetCtx = createContext<() => void>(() => {});
export const useSheetClose = () => useContext(SheetCtx);

/** Centred modal with a blurred scrim; Escape and scrim clicks both dismiss. */
export function Sheet({
  open, onClose, title, subtitle, children, footer, onBack, aside, width = 520, full,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Something the sheet is rather than something it asks — a record's own
   *  id, say. It rides in the header beside the way out, where it is
   *  reachable without being another line of the form. */
  aside?: ReactNode;
  /** Set when the sheet is showing a page of its own: puts a way back in the
   *  header, where the title has already changed to say where you are. */
  onBack?: () => void;
  width?: number;
  /** Nearly the whole window, for work that is a table rather than a form. */
  full?: boolean;
}) {
  // The phone's native tab bar sits above the web view and would be drawn
  // over the sheet's foot, so it steps down while any sheet is open.
  useEffect(() => {
    if (!open) return;
    holdNativeTabs(true);
    return () => holdNativeTabs(false);
  }, [open]);

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

  // On a phone the sheet comes up from the bottom edge and can be thrown back
  // down at it. That is not decoration: a centred card with a 24px gutter is
  // 342pt wide on an iPhone, its close button is at the top of a reach, and
  // nothing about it says which way out is. A sheet you push down says it
  // without a word.
  const phone = usePhone();
  const dragControls = useDragControls();

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
              /* The width rides in as a custom property rather than as
                 `max-width` outright, so the phone's stylesheet can take the
                 whole window without having to shout `!important` at an
                 inline style. */
              style={{ ['--sheet-w' as string]: `${width}px` }}
              variants={phone && !full ? sheetPhone : sheetPanel}
              initial="initial"
              animate="animate"
              exit="exit"
              /* Downwards only, and only from the sheet's own chrome — a drag
                 that started on a list would fight the list's scroll. Past a
                 third of the way, or thrown hard enough, it goes. */
              drag={phone && !full ? 'y' : false}
              dragDirectionLock
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0.02, bottom: 0.7 }}
              dragListener={false}
              dragControls={dragControls}
              onDragEnd={(_, info) => {
                if (info.offset.y > 130 || info.velocity.y > 700) onClose();
              }}
              role="dialog"
              aria-modal="true"
              aria-label={title}
            >
              <header className="sheet-head">
                {/* The grip is the drag handle and the drag handle is the
                    grip: it is the one part of a sheet that is not content,
                    so it is the one part safe to start a gesture on. */}
                {phone && !full && (
                  <motion.div
                    className="sheet-grip"
                    onPointerDown={(e) => dragControls.start(e)}
                    aria-hidden
                  />
                )}
                {onBack && (
                  <IconButton icon="chevron-left" label="Back" onClick={onBack} />
                )}
                {/* A phone's sheet has iOS's round close top left, and carries
                    its one primary button top right as a round tick — the footer is
                    drawn again up here and the stylesheet keeps only that
                    button of it (`.sheet-head-action` in mobile.css). Saving
                    is then never a scroll away or under the keyboard. */}
                {phone && footer && !onBack && (
                  <button type="button" className="sheet-head-cancel" onClick={onClose} aria-label="Cancel">
                    <Icon name="x" size={18} strokeWidth={2.4} />
                  </button>
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
                {!(phone && footer) && aside}
                {phone && footer ? (
                  <div className="sheet-head-action">{footer}</div>
                ) : (
                  <IconButton icon="x" label="Close" onClick={onClose} />
                )}
              </header>
              <div className="sheet-body">
                <SheetCanvas full={full || phone}>
                  {children}
                </SheetCanvas>
              </div>
              {footer && <footer className={`sheet-foot ${phone ? 'is-phone' : ''}`}>{footer}</footer>}
            </motion.div>
          </motion.div>
        </SheetCtx.Provider>
      )}
    </AnimatePresence>
  );
}

/**
 * What a sheet is holding, measured.
 *
 * The content is laid out at the width the sheet is heading for, not the one
 * it is passing through: a sheet that grows a column would otherwise reflow at
 * every width on the way — two columns squeezed into six hundred pixels,
 * wrapping down the page — and lurch taller before settling back.
 *
 * The height is carried the same way. A field that appears, a panel that
 * swaps, an error that arrives: the panel glides into its new size instead of
 * jumping to it, and everything under the sheet stops flinching.
 */
function SheetCanvas({
  full, children,
}: {
  /** Set when the box is the sheet's own width and the height is the page's
   *  to choose — a full-window sheet, or any sheet on a phone, where the
   *  panel is already as wide as the window and as tall as it is allowed. */
  full?: boolean;
  children: ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  // Held to the box only while it is moving: a menu hanging off a field near
  // the foot of the form must not be cut off once it has settled.
  const [moving, setMoving] = useState(false);

  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.height;
      // A page on its way out leaves the canvas empty for a frame. Keeping
      // the last height stops the sheet collapsing and reopening around the
      // page arriving behind it.
      if (next > 0) setHeight(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      className="sheet-canvas"
      style={{ overflow: moving && !full ? 'hidden' : undefined }}
      // Whatever it opens at is its own height already; only what happens
      // after is worth animating.
      initial={false}
      animate={{ height: full ? 'auto' : height }}
      transition={springSoft}
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
    >
      <div ref={inner} className="sheet-canvas-inner">{children}</div>
    </motion.div>
  );
}

/* ----------------------------------------------------------------- Switch */

/**
 * On or off, said the way a switch says it. A tick box asks you to read a
 * sentence and work out what ticking it would mean; a switch shows the state
 * it is in and moves when you change it.
 */
export function Switch({
  on, onChange, label, hint, disabled, size = 'md', ariaLabel,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Left off where the row it sits on already says what it is for. */
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** `lg` for a switch that answers a row of its own rather than a line. */
  size?: 'md' | 'lg';
  /** What a label-less switch is called, for anyone who cannot see the row. */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label ? undefined : ariaLabel ?? 'Toggle'}
      disabled={disabled}
      className={`switch ${on ? 'is-on' : ''} ${label ? 'has-label' : ''} ${
        size === 'lg' ? 'switch-lg' : ''
      }`}
      onClick={() => onChange(!on)}
    >
      <span className="switch-track">
        <motion.span layout className="switch-knob" transition={spring} />
      </span>
      {label && (
        <span className="switch-label">
          {label}
          {hint && <small>{hint}</small>}
        </span>
      )}
    </button>
  );
}

/* ---------------------------------------------------------------- Confirm */

/**
 * The last word before something that cannot be taken back. A dialog rather
 * than a second click on the same button: a delete that fires from where the
 * pointer already rests is a delete nobody agreed to.
 */
export function Confirm({
  open, onConfirm, onCancel, title, children,
  confirmLabel = 'Delete', icon = 'trash-2', tone = 'danger', busy = false,
  stacked = false,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  icon?: string;
  tone?: ButtonTone;
  busy?: boolean;
  /** Opened from inside a sheet, which it has to sit above. */
  stacked?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    // Captured, so Escape answers this and stops there. Whatever is underneath
    // listens on the same document and would otherwise close along with it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  // Through a portal: the sheet this opens from is animated, and a transformed
  // ancestor anchors a fixed scrim to itself rather than to the window.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={`scrim ${stacked ? 'is-stacked' : ''}`}
          variants={sheetBackdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
        >
          <motion.div
            className="sheet is-confirm"
            variants={sheetPanel}
            initial="initial"
            animate="animate"
            exit="exit"
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
          >
            <header className="sheet-head">
              <div className="sheet-heading">
                <h2 className="sheet-title">{title}</h2>
              </div>
            </header>
            {children && (
              <div className="sheet-body">
                <p className="confirm-body">{children}</p>
              </div>
            )}
            <footer className="sheet-foot">
              <div className="foot-actions">
                <Button tone="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                <Button tone={tone} icon={icon} onClick={onConfirm} disabled={busy} autoFocus>
                  {confirmLabel}
                </Button>
              </div>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
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

/** The colour a drawing is done in: one of the book's own accents. */
export type EmptyTone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'ink';

/**
 * What a page shows when there is nothing on it: a small drawing of the
 * thing that will be there, a title, and only rarely a line under it — the
 * way drivea heads its empty pages. The drawing is in the state's tone, so
 * a cleared inbox is green, a page that went wrong red, and a list that has
 * not started yet the book's blue.
 *
 * - `art` names the scene (see `EmptyArt.tsx`).
 * - `body` is for what the title cannot say on its own.
 * - `action` is only for a way out the screen does not already offer.
 * - `screen` takes the height the list would have had; leave it off inside
 *   a card that has its own heading, where the drawing is drawn smaller.
 */
export function Empty({
  title, body, action, screen, art = 'inbox', tone = 'blue',
}: {
  title: string;
  body?: string;
  art?: EmptyArtName;
  tone?: EmptyTone;
  /**
   * Only where the screen's own header doesn't already carry the same
   * button. An empty state that repeats the header is the same button
   * twice on one screen, and the eye has to work out whether it is.
   */
  action?: ReactNode;
  /**
   * Takes the height the list would have had, so the words sit in the middle
   * of the screen rather than at the top of it. For an empty state standing
   * on its own; leave it off inside a card that has its own heading.
   */
  screen?: boolean;
}) {
  return (
    <motion.div
      className={`empty tone-${tone} ${screen ? 'is-screen' : ''}`}
      initial="initial"
      animate="animate"
      variants={emptyStack}
    >
      <motion.div className="empty-art-wrap" variants={emptyArt}>
        <EmptyArt name={art} />
      </motion.div>
      <motion.h4 variants={emptyLine}>{title}</motion.h4>
      {body && <motion.p variants={emptyLine}>{body}</motion.p>}
      {action && (
        <motion.div className="empty-action" variants={emptyLine}>
          {action}
        </motion.div>
      )}
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
