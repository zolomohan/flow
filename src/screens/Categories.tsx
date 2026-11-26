import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, Reorder, useDragControls } from 'motion/react';
import { CATEGORY_ICON_GROUPS, Icon } from '../components/Icon';
import {
  Button, Card, CardHead, Empty, Field, IconButton, MoreMenu, Segmented, Select, Sheet, TextInput,
  type SegmentOption, type SelectOption,
} from '../components/ui';
import { useStore } from '../lib/store';
import { usePhone } from '../lib/media';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Category, CategoryKind } from '../lib/types';

const KINDS: SegmentOption<CategoryKind>[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

const SWATCHES = [
  '#F2724F', '#42C251', '#118AE4', '#A855F7', '#F0B429', '#5A87E6',
  '#EC4899', '#8B5CF6', '#06B6D4', '#0EA5E9', '#14B8A6', '#676B89',
];

/** "3 transactions" / "1 transaction" — used all over the category surfaces. */
const plural = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`;

/** Which face of the category sheet to open on, and what it is opening for. */
type Mode = 'form' | 'move' | 'delete';

interface SheetRequest {
  /** null when creating something new. */
  category: Category | null;
  kind: CategoryKind;
  mode: Mode;
  /** Set when adding a sub-category from a group's own plus button. */
  parentId?: string | null;
}

/**
 * The labels behind every transaction, and the tools for putting them right:
 * renaming, regrouping, moving what is filed under one into another, and
 * retiring the ones that turned out to be the same thing twice.
 */
export function Categories({ onOpenCategory }: {
  /** Takes the ledger to everything filed under a category, over all time. */
  onOpenCategory: (categoryId: string) => void;
}) {
  // The request outlives its own dismissal so the sheet keeps its content
  // through the closing animation.
  const [request, setRequest] = useState<SheetRequest | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const open = (next: SheetRequest) => {
    setRequest(next);
    setSheetOpen(true);
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Categories</h1>
          <p>Rename, group, and remove the categories behind your transactions.</p>
        </div>
      </header>

      <CategoriesPanel onOpen={open} onOpenCategory={onOpenCategory} />

      <CategorySheet
        open={sheetOpen}
        request={request}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  );
}


/* ------------------------------------------------------------- Categories */

function CategoriesPanel({ onOpen, onOpenCategory }: {
  onOpen: (request: SheetRequest) => void;
  onOpenCategory: (categoryId: string) => void;
}) {
  const { categories, categoryUsage } = useStore();
  const [kind, setKind] = useState<CategoryKind>('expense');

  const mine = useMemo(() => categories.filter((c) => c.kind === kind), [categories, kind]);
  const tops = mine.filter((c) => !c.parentId);
  const count = (id: string) => categoryUsage[id] ?? 0;
  const filed = mine.reduce((sum, c) => sum + count(c.id), 0);

  // Kept mounted through its own closing animation, like the category sheet.
  const [ordering, setOrdering] = useState(false);

  const newCategory = () => onOpen({ category: null, kind, mode: 'form' });

  return (
    <Card>
      <CardHead
        title={kind === 'expense' ? 'Expense categories' : 'Income categories'}
        hint={
          `${tops.length} ${tops.length === 1 ? 'group' : 'groups'} · ` +
          `${mine.length - tops.length} sub-categories · ${plural(filed)} filed`
        }
        action={
          <div className="cat-head-actions">
            <Segmented options={KINDS} value={kind} onChange={setKind} name="cat-kind-filter" size="sm" />
            <Button
              size="sm"
              icon="arrow-up-down"
              disabled={mine.length < 2}
              onClick={() => setOrdering(true)}
            >
              Reorder
            </Button>
            <Button size="sm" tone="primary" icon="plus" onClick={newCategory}>
              New category
            </Button>
          </div>
        }
      />

      {tops.length === 0 ? (
        <Empty
          title={`No ${kind} categories yet`}
          body="Categories group your spending so totals and charts make sense."
        />
      ) : (
        <motion.div
          className="cat-rows"
          variants={listVariants}
          initial="initial"
          animate="animate"
          key={kind}
        >
          {tops.map((group) => {
            const children = mine.filter((c) => c.parentId === group.id);
            return (
              <motion.div key={group.id} className="cat-row-group" variants={itemVariants}>
                <CategoryRow
                  category={group}
                  count={count(group.id)}
                  subCount={children.length}
                  subTotal={children.reduce((sum, c) => sum + count(c.id), 0)}
                  onAddSub={() =>
                    onOpen({ category: null, kind, mode: 'form', parentId: group.id })
                  }
                  onOpen={onOpen}
                  onOpenCategory={onOpenCategory}
                />
                {children.length > 0 && (
                  <div className="cat-subrows">
                    {children.map((child) => (
                      <CategoryRow
                        key={child.id}
                        category={child}
                        count={count(child.id)}
                        sub
                        onOpen={onOpen}
                        onOpenCategory={onOpenCategory}
                      />
                    ))}
                  </div>
                )}
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <ReorderSheet open={ordering} kind={kind} onClose={() => setOrdering(false)} />
    </Card>
  );
}

function CategoryRow({
  category, count, subCount = 0, subTotal = 0, sub = false, onAddSub, onOpen, onOpenCategory,
}: {
  category: Category;
  count: number;
  subCount?: number;
  /** Transactions sitting in this group's sub-categories, which a move can sweep up too. */
  subTotal?: number;
  sub?: boolean;
  /** Only a group can hold sub-categories, so only a group gets the plus. */
  onAddSub?: () => void;
  onOpen: (request: SheetRequest) => void;
  onOpenCategory: (categoryId: string) => void;
}) {
  const go = (mode: Mode) => () => onOpen({ category, kind: category.kind, mode });
  // Four glyphs a row left a phone a word of each name. There the four go
  // behind one, and the name gets the row back.
  const phone = usePhone();
  // Nothing is filed on a group, so saying "0 transactions" of one says
  // nothing: what it is worth knowing is how much sits under it.
  const meta = subCount
    ? `${subCount} sub-${subCount === 1 ? 'category' : 'categories'} · ${plural(count + subTotal)}`
    : count
      ? plural(count)
      : 'nothing filed here yet';

  return (
    <div className={`cat-row ${sub ? 'is-sub' : ''}`} style={{ ['--cat' as any]: category.color }}>
      {/* The row itself goes to what is filed under it — the pencil beside it
          is the way to change the category, and always was. */}
      <button
        className="cat-row-main"
        title={`Show everything filed under ${category.name}`}
        onClick={() => onOpenCategory(category.id)}
      >
        <span className="cat-row-glyph">
          <Icon name={category.icon} size={sub ? 14 : 17} strokeWidth={2.1} />
        </span>
        <span className="cat-row-text">
          <strong>{category.name}</strong>
          <span>{meta}</span>
        </span>
        <span className="cat-row-go">
          <Icon name="chevron-right" size={15} />
        </span>
      </button>
      {phone ? (
        <div className="cat-row-actions">
          <MoreMenu
            label={`Change ${category.name}`}
            items={[
              ...(onAddSub
                ? [{ icon: 'plus', label: 'Add a sub-category', onClick: onAddSub }]
                : []),
              { icon: 'pencil', label: 'Edit', onClick: go('form') },
              ...(count + subTotal > 0
                ? [{ icon: 'arrow-left-right', label: 'Move transactions out', onClick: go('move') }]
                : []),
              { icon: 'trash-2', label: 'Delete', onClick: go('delete') },
            ]}
          />
        </div>
      ) : (
      <div className="cat-row-actions">
        {onAddSub && (
          <IconButton
            icon="plus"
            label={`Add a sub-category to ${category.name}`}
            size={30}
            onClick={onAddSub}
          />
        )}
        <IconButton icon="pencil" label={`Edit ${category.name}`} size={30} onClick={go('form')} />
        <IconButton
          icon="arrow-left-right"
          label={`Move transactions out of ${category.name}`}
          size={30}
          disabled={count + subTotal === 0}
          onClick={go('move')}
        />
        <IconButton
          icon="trash-2"
          label={`Delete ${category.name}`}
          size={30}
          tone="danger"
          onClick={go('delete')}
        />
      </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Reorder */

/** Every group of a kind, each followed by its own children, as one list of
 *  ids — the shape the order is saved in, and the one to compare against to
 *  know whether anything actually moved. */
const flatten = (groups: string[], children: Record<string, string[]>) =>
  groups.flatMap((id) => [id, ...(children[id] ?? [])]);

/**
 * The order the categories appear in, everywhere: drag the groups into place,
 * open one to sort what sits under it. A level only ever sorts against
 * itself, so a sub-category can never be dragged out of its group by
 * accident — moving one between groups is the form's job, not this.
 */
function ReorderSheet({ open, kind, onClose }: {
  open: boolean;
  kind: CategoryKind;
  onClose: () => void;
}) {
  const { categories, categoryUsage, reorderCategories } = useStore();

  const byId = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const saved = useMemo(() => {
    const mine = categories.filter((c) => c.kind === kind);
    const groups = mine.filter((c) => !c.parentId).map((c) => c.id);
    const children: Record<string, string[]> = {};
    for (const id of groups) {
      children[id] = mine.filter((c) => c.parentId === id).map((c) => c.id);
    }
    return { groups, children };
  }, [categories, kind]);

  const [groups, setGroups] = useState<string[]>([]);
  const [children, setChildren] = useState<Record<string, string[]>>({});
  // One group open at a time: the popup stays short enough to drag across.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setGroups(saved.groups);
    setChildren(saved.children);
    setExpanded(null);
    setBusy(false);
  }, [open, saved]);

  const moved =
    flatten(groups, children).join() !== flatten(saved.groups, saved.children).join();

  const save = async () => {
    setBusy(true);
    try {
      await reorderCategories(flatten(groups, children));
      onClose();
    } catch {
      // The store already raised a toast; keep the order on screen to retry.
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Reorder categories"
      width={440}
      footer={
        <>
          <span />
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" disabled={!moved || busy} onClick={save}>
              Save order
            </Button>
          </div>
        </>
      }
    >
      <Reorder.Group
        as="div"
        axis="y"
        className="ro-list"
        values={groups}
        onReorder={setGroups}
      >
        {groups.map((id) => {
          const group = byId.get(id);
          if (!group) return null;
          const subs = children[id] ?? [];
          return (
            <ReorderGroupRow
              key={id}
              group={group}
              subs={subs}
              byId={byId}
              usage={categoryUsage}
              expanded={expanded === id}
              onToggle={() => setExpanded((current) => (current === id ? null : id))}
              onReorderSubs={(next) => setChildren((all) => ({ ...all, [id]: next }))}
            />
          );
        })}
      </Reorder.Group>
    </Sheet>
  );
}

function ReorderGroupRow({
  group, subs, byId, usage, expanded, onToggle, onReorderSubs,
}: {
  group: Category;
  subs: string[];
  byId: Map<string, Category>;
  usage: Record<string, number>;
  expanded: boolean;
  onToggle: () => void;
  onReorderSubs: (next: string[]) => void;
}) {
  // Dragging starts at the grip alone, so a click can still open the group —
  // and so a sub-category being dragged never takes its group with it.
  const controls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={group.id}
      dragListener={false}
      dragControls={controls}
      className={`ro-item ${expanded ? 'is-open' : ''}`}
      style={{ ['--cat' as any]: group.color }}
    >
      <div className="ro-row">
        <span
          className="ro-grip"
          title={`Drag to move ${group.name}`}
          onPointerDown={(e) => controls.start(e)}
        >
          <Icon name="grip-vertical" size={15} />
        </span>
        <button
          className="ro-main"
          onClick={onToggle}
          disabled={subs.length === 0}
          aria-expanded={expanded}
          title={
            subs.length
              ? `${expanded ? 'Hide' : 'Show'} the sub-categories of ${group.name}`
              : `${group.name} has no sub-categories`
          }
        >
          <span className="ro-glyph">
            <Icon name={group.icon} size={16} strokeWidth={2.1} />
          </span>
          <span className="ro-text">
            <strong>{group.name}</strong>
            <span>
              {subs.length
                ? `${subs.length} sub-${subs.length === 1 ? 'category' : 'categories'}`
                : 'no sub-categories'}
            </span>
          </span>
          {subs.length > 0 && (
            <motion.span
              className="ro-caret"
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={spring}
            >
              <Icon name="chevron-down" size={15} />
            </motion.span>
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded && subs.length > 0 && (
          <motion.div
            className="ro-subs"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
          >
            <Reorder.Group
              as="div"
              axis="y"
              className="ro-sublist"
              values={subs}
              onReorder={onReorderSubs}
            >
              {subs.map((id) => {
                const child = byId.get(id);
                return child ? (
                  <ReorderSubRow key={id} category={child} count={usage[id] ?? 0} />
                ) : null;
              })}
            </Reorder.Group>
          </motion.div>
        )}
      </AnimatePresence>
    </Reorder.Item>
  );
}

function ReorderSubRow({ category, count }: { category: Category; count: number }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={category.id}
      dragListener={false}
      dragControls={controls}
      className="ro-row is-sub"
      style={{ ['--cat' as any]: category.color }}
    >
      <span
        className="ro-grip"
        title={`Drag to move ${category.name}`}
        onPointerDown={(e) => controls.start(e)}
      >
        <Icon name="grip-vertical" size={14} />
      </span>
      <span className="ro-glyph">
        <Icon name={category.icon} size={13} strokeWidth={2.1} />
      </span>
      <span className="ro-text">
        <strong>{category.name}</strong>
        <span>{count ? plural(count) : 'nothing filed here yet'}</span>
      </span>
    </Reorder.Item>
  );
}

/* ------------------------------------------------------------- Appearance */

const SCOPES: SegmentOption<'own' | 'all'>[] = [
  { value: 'own', label: 'This one only' },
  { value: 'all', label: 'Include sub-categories' },
];

const CHILD_FATES: SegmentOption<'keep' | 'delete'>[] = [
  { value: 'keep', label: 'Move to top level' },
  { value: 'delete', label: 'Delete them too' },
];

function CategorySheet({
  open, request, onClose,
}: {
  open: boolean;
  request: SheetRequest | null;
  onClose: () => void;
}) {
  const { categories, categoryUsage, saveCategory, deleteCategory, reassignCategory } = useStore();
  const editing = request?.category ?? null;

  const [mode, setMode] = useState<Mode>('form');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('circle-dashed');
  const [color, setColor] = useState(SWATCHES[0]);
  const [thisKind, setThisKind] = useState<CategoryKind>('expense');
  const [parentId, setParentId] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [scope, setScope] = useState<'own' | 'all'>('own');
  const [childFate, setChildFate] = useState<'keep' | 'delete'>('keep');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !request) return;
    const parent = request.category?.parentId ?? request.parentId ?? null;
    setMode(request.mode);
    setName(request.category?.name ?? '');
    setIcon(request.category?.icon ?? 'circle-dashed');
    setColor(
      // A sub-category is opened in its group's colour, which is the only
      // colour it can have.
      categories.find((c) => c.id === parent)?.color
        ?? request.category?.color
        ?? SWATCHES[0],
    );
    setThisKind(request.category?.kind ?? request.kind);
    setParentId(parent);
    setTarget(null);
    setScope('own');
    setChildFate('keep');
    setBusy(false);
  }, [open, request, categories]);

  const parentGroup = useMemo(
    () => categories.find((c) => c.id === parentId) ?? null,
    [categories, parentId],
  );

  const children = useMemo(
    () => (editing ? categories.filter((c) => c.parentId === editing.id) : []),
    [categories, editing],
  );
  const hasChildren = children.length > 0;

  const own = editing ? categoryUsage[editing.id] ?? 0 : 0;
  const inChildren = children.reduce((sum, c) => sum + (categoryUsage[c.id] ?? 0), 0);

  // Only top-level categories of the same kind can be a parent, and a group
  // can never be nested under itself.
  const parentOptions: SelectOption[] = categories
    .filter((c) => c.kind === thisKind && !c.parentId && c.id !== editing?.id)
    .map((c) => ({ value: c.id, label: c.name, icon: c.icon, color: c.color }));

  // Everywhere transactions can land: same kind, never the category itself,
  // and never a child that is about to be deleted alongside it.
  const destinations: SelectOption[] = useMemo(() => {
    if (!editing) return [];
    const gone = new Set([editing.id]);
    if (mode === 'delete' && childFate === 'delete') children.forEach((c) => gone.add(c.id));
    if (mode === 'move' && scope === 'all') children.forEach((c) => gone.add(c.id));
    return categories
      .filter((c) => c.kind === editing.kind && !gone.has(c.id))
      // A group is a heading: nothing is filed on it, so nothing can be moved
      // onto it either. Its children are what the transactions can land in.
      .filter((c) => !categories.some((k) => k.parentId === c.id))
      .map((c) => ({
        value: c.id,
        label: c.name,
        icon: c.icon,
        color: c.color,
        hint: categoryUsage[c.id] ? plural(categoryUsage[c.id]) : undefined,
        group: c.parentId
          ? categories.find((p) => p.id === c.parentId)?.name ?? 'Sub-categories'
          : 'Categories',
      }));
  }, [categories, categoryUsage, children, childFate, editing, mode, scope]);

  const movingCount = scope === 'all' ? own + inChildren : own;
  const deletingCount = childFate === 'delete' ? own + inChildren : own;

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
      onClose();
    } catch {
      // The store already raised a toast; stay put so the choice can be fixed.
      setBusy(false);
    }
  };

  const titles: Record<Mode, { title: string; subtitle: string }> = {
    form: {
      title: editing
        ? 'Edit category'
        : parentGroup
          ? 'New sub-category'
          : 'New category',
      subtitle: parentGroup
        ? `Filed under ${parentGroup.name}, in its colour`
        : 'Groups your transactions and colours your charts',
    },
    move: {
      title: `Move transactions out of ${editing?.name ?? ''}`,
      subtitle: 'The category itself stays exactly where it is',
    },
    delete: {
      title: `Delete ${editing?.name ?? ''}?`,
      subtitle: 'Choose where its transactions should go first',
    },
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={titles[mode].title}
      subtitle={titles[mode].subtitle}
      width={470}
      footer={
        mode === 'form' ? (
          <>
            {editing ? (
              <Button tone="danger" icon="trash-2" onClick={() => setMode('delete')}>
                Delete
              </Button>
            ) : <span />}
            <div className="foot-actions">
              <Button tone="ghost" onClick={onClose}>Cancel</Button>
              <Button
                tone="primary"
                disabled={busy}
                onClick={async () => {
                  if (!name.trim()) return;
                  await run(() => saveCategory({
                    id: editing?.id ?? null,
                    kind: thisKind,
                    name: name.trim(),
                    icon,
                    color,
                    parentId,
                  }));
                }}
              >
                {editing ? 'Save changes' : parentGroup ? 'Add sub-category' : 'Add category'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span />
            <div className="foot-actions">
              <Button tone="ghost" onClick={() => setMode('form')}>Back</Button>
              {mode === 'move' ? (
                <Button
                  tone="primary"
                  icon="arrow-left-right"
                  disabled={!target || !movingCount || busy}
                  onClick={() => run(() => reassignCategory(editing!.id, target!, scope === 'all'))}
                >
                  Move {plural(movingCount)}
                </Button>
              ) : (
                <Button
                  tone="danger"
                  icon="trash-2"
                  disabled={busy}
                  onClick={() => run(() => deleteCategory(editing!.id, {
                    reassignTo: target,
                    deleteChildren: childFate === 'delete',
                  }))}
                >
                  Delete category
                </Button>
              )}
            </div>
          </>
        )
      }
    >
      {mode === 'form' ? (
        <div className="account-form">
          <div className="cat-preview" style={{ ['--cat' as any]: color }}>
            <span className="cat-glyph">
              <Icon name={icon} size={18} strokeWidth={2.1} />
            </span>
            {name || 'Category name'}
          </div>

          <Segmented options={KINDS} value={thisKind} onChange={setThisKind} name="cat-kind" size="sm" />

          <Field label="Name">
            <TextInput value={name} placeholder="Coffee" onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field
            label="Group"
            hint={hasChildren ? 'this one has sub-categories of its own' : 'optional'}
            error={
              hasChildren && parentId
                ? 'Its sub-categories will move to the top level.'
                : null
            }
          >
            <Select
              options={parentOptions}
              value={parentId}
              onChange={(next) => {
                setParentId(next);
                const group = categories.find((c) => c.id === next);
                if (group) setColor(group.color);
              }}
              placeholder="Top level"
              allowClear
            />
          </Field>

          <div>
            <span className="field-label">
              Colour
              {parentGroup ? (
                <span className="field-hint">sub-categories wear their group's</span>
              ) : hasChildren ? (
                <span className="field-hint">
                  its {children.length} sub-{children.length === 1 ? 'category' : 'categories'} follow
                </span>
              ) : null}
            </span>
            {parentGroup ? (
              <motion.p
                className="cat-inherited"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
              >
                <i style={{ background: color }} />
                Taken from {parentGroup.name}
              </motion.p>
            ) : (
            <div className="swatch-row">
              {SWATCHES.map((s) => (
                <motion.button
                  key={s}
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  className={`swatch-pick ${s === color ? 'is-active' : ''}`}
                  style={{ background: s }}
                  onClick={() => setColor(s)}
                  aria-label={`Colour ${s}`}
                >
                  {s === color && (
                    <motion.span layoutId="cat-swatch-ring" className="swatch-ring" transition={spring} />
                  )}
                </motion.button>
              ))}
            </div>
            )}
          </div>

          <div>
            <span className="field-label">Icon</span>
            <div className="icon-shelves">
              {CATEGORY_ICON_GROUPS.map((shelf) => (
                <div key={shelf.label} className="icon-shelf">
                  <span className="icon-shelf-label">{shelf.label}</span>
                  <div className="icon-row">
                    {shelf.icons.map((option) => (
                      <motion.button
                        key={option}
                        type="button"
                        whileTap={{ scale: 0.92 }}
                        className={`icon-pick ${option === icon ? 'is-active' : ''}`}
                        style={option === icon ? ({ ['--pick' as any]: color }) : undefined}
                        onClick={() => setIcon(option)}
                        aria-label={option}
                      >
                        <Icon name={option} size={17} />
                      </motion.button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {editing && (
            <div className="cat-usage">
              <div>
                <strong>{plural(own)} filed here</strong>
                <p>
                  {hasChildren
                    ? `${plural(inChildren)} more sit in its ${children.length} sub-categories.`
                    : 'Move them somewhere else without touching the category.'}
                </p>
              </div>
              <Button
                size="sm"
                icon="arrow-left-right"
                disabled={own + inChildren === 0}
                onClick={() => { setTarget(null); setScope('own'); setMode('move'); }}
              >
                Move all
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="account-form">
          <div className="cat-preview" style={{ ['--cat' as any]: editing?.color }}>
            <span className="cat-glyph">
              <Icon name={editing?.icon ?? 'circle-dashed'} size={18} strokeWidth={2.1} />
            </span>
            {editing?.name}
            <span className="cat-tally">{plural(mode === 'move' ? movingCount : deletingCount)}</span>
          </div>

          {hasChildren && (
            <Field
              label={mode === 'move' ? 'What to move' : `Its ${children.length} sub-categories`}
              hint={children.map((c) => c.name).join(', ')}
            >
              {mode === 'move' ? (
                <Segmented options={SCOPES} value={scope} onChange={setScope} name="cat-scope" size="sm" />
              ) : (
                <Segmented
                  options={CHILD_FATES}
                  value={childFate}
                  onChange={(next) => { setChildFate(next); setTarget(null); }}
                  name="cat-children"
                  size="sm"
                />
              )}
            </Field>
          )}

          <Field
            label={mode === 'move' ? 'Move them to' : 'File its transactions under'}
            hint={mode === 'delete' ? 'optional' : undefined}
            error={
              mode === 'move' && !movingCount
                ? 'Nothing is filed here yet.'
                : null
            }
          >
            <Select
              options={destinations}
              value={target}
              onChange={setTarget}
              placeholder={mode === 'delete' ? 'Leave them uncategorised' : 'Pick a category'}
              allowClear={mode === 'delete'}
            />
          </Field>

          {mode === 'delete' && (
            <p className="sheet-note">
              {deletingCount === 0
                ? 'Nothing is filed here, so the category just goes.'
                : target
                  ? `${plural(deletingCount)} will move across, then the category ${childFate === 'delete' && hasChildren ? 'and its sub-categories go' : 'goes'} for good.`
                  : `${plural(deletingCount)} will be left uncategorised. This cannot be undone.`}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
