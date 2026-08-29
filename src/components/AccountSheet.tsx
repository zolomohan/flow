import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ACCOUNT_ICONS, Icon } from './Icon';
import { Button, Field, Segmented, Sheet, TextInput, type SegmentOption } from './ui';
import { useStore } from '../lib/store';
import { money, paiseToRupeeString, rupeesToPaise } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Account, AccountKind } from '../lib/types';

const KINDS: SegmentOption<AccountKind>[] = [
  { value: 'bank', label: 'Bank' },
  { value: 'credit', label: 'Credit' },
  { value: 'cash', label: 'Cash' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'investment', label: 'Invest' },
];

const SWATCHES = [
  '#20294C', '#118AE4', '#42C251', '#7C3AED', '#F0B429', '#E0433D',
  '#0EA5E9', '#14B8A6', '#EC4899', '#F2724F', '#5A87E6', '#676B89',
];

const DEFAULT_ICON: Record<AccountKind, string> = {
  bank: 'landmark',
  credit: 'credit-card',
  cash: 'wallet',
  wallet: 'smartphone',
  investment: 'trending-up',
};

export function AccountSheet({
  open, onClose, editing,
}: { open: boolean; onClose: () => void; editing?: Account | null }) {
  const { saveAccount, deleteAccount, setAccountArchived } = useStore();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind>('bank');
  const [institution, setInstitution] = useState('');
  const [opening, setOpening] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [icon, setIcon] = useState('landmark');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setKind(editing.kind);
      setInstitution(editing.institution ?? '');
      setOpening(paiseToRupeeString(editing.openingBalance));
      setColor(editing.color);
      setIcon(editing.icon);
      setLimit(paiseToRupeeString(editing.creditLimit));
    } else {
      setName('');
      setKind('bank');
      setInstitution('');
      setOpening('');
      setColor(SWATCHES[0]);
      setIcon('landmark');
      setLimit('');
    }
    setError(null);
    setConfirming(false);
  }, [open, editing]);

  // Follow the account type unless the user has chosen a glyph themselves.
  const chooseKind = (next: AccountKind) => {
    if (icon === DEFAULT_ICON[kind]) setIcon(DEFAULT_ICON[next]);
    setKind(next);
  };

  const submit = async () => {
    if (!name.trim()) return setError('Give the account a name.');
    await saveAccount({
      id: editing?.id ?? null,
      name: name.trim(),
      kind,
      institution: institution.trim() || null,
      openingBalance: rupeesToPaise(opening),
      color,
      icon,
      creditLimit: kind === 'credit' ? rupeesToPaise(limit) : 0,
    });
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit account' : 'New account'}
      subtitle={
        editing
          ? `Live balance ${money(editing.balance)}`
          : 'Where the money sits — a bank, a card, a wallet, a fund'
      }
      width={520}
      footer={
        <>
          {editing ? (
            <div className="foot-actions">
              <Button
                tone="ghost"
                icon={editing.archived ? 'undo-2' : 'inbox'}
                onClick={async () => {
                  await setAccountArchived(editing.id, !editing.archived);
                  onClose();
                }}
              >
                {editing.archived ? 'Restore' : 'Archive'}
              </Button>
              <Button
                tone="danger"
                icon="trash-2"
                onClick={async () => {
                  if (!confirming) return setConfirming(true);
                  await deleteAccount(editing.id);
                  onClose();
                }}
              >
                {confirming ? 'Delete with its history?' : 'Delete'}
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>
              {editing ? 'Save changes' : 'Add account'}
            </Button>
          </div>
        </>
      }
    >
      <div className="account-form">
        <motion.div className="account-preview" style={{ background: color }} layout>
          <span className="account-preview-glyph">
            <Icon name={icon} size={20} />
          </span>
          <div>
            <strong>{name || 'Account name'}</strong>
            <span>{institution || KINDS.find((k) => k.value === kind)?.label}</span>
          </div>
          <span className="account-preview-balance">
            {money(rupeesToPaise(opening))}
          </span>
        </motion.div>

        <Segmented options={KINDS} value={kind} onChange={chooseKind} name="acct-kind" size="sm" />

        <div className="tx-meta">
          <Field label="Name" error={error}>
            <TextInput
              value={name}
              placeholder="Savings"
              onChange={(e) => { setName(e.target.value); setError(null); }}
            />
          </Field>
          <Field label="Institution" hint="optional">
            <TextInput
              value={institution}
              placeholder="HDFC Bank"
              onChange={(e) => setInstitution(e.target.value)}
            />
          </Field>
        </div>

        <div className="tx-meta">
          <Field
            label="Opening balance"
            hint={kind === 'credit' ? 'owed when tracking began' : 'before any transactions'}
          >
            <div className="rupee-input">
              <span>₹</span>
              <TextInput
                inputMode="decimal"
                value={opening}
                placeholder="0"
                // A leading minus is allowed: an account can start overdrawn,
                // and an imported opening balance often is.
                onChange={(e) =>
                  setOpening(e.target.value.replace(/[^0-9.-]/g, '').replace(/(?!^)-/g, ''))
                }
              />
            </div>
          </Field>
          <AnimatePresence mode="popLayout">
            {kind === 'credit' && (
              <motion.div
                key="limit"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                transition={spring}
              >
                <Field label="Credit limit" hint="optional">
                  <div className="rupee-input">
                    <span>₹</span>
                    <TextInput
                      inputMode="decimal"
                      value={limit}
                      placeholder="0"
                      onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
                    />
                  </div>
                </Field>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div>
          <span className="field-label">Colour</span>
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
                  <motion.span layoutId="swatch-ring" className="swatch-ring" transition={spring} />
                )}
              </motion.button>
            ))}
          </div>
        </div>

        <div>
          <span className="field-label">Icon</span>
          <motion.div
            className="icon-row"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {ACCOUNT_ICONS.map((name) => (
              <motion.button
                key={name}
                type="button"
                variants={itemVariants}
                whileTap={{ scale: 0.92 }}
                className={`icon-pick ${name === icon ? 'is-active' : ''}`}
                style={name === icon ? { ['--pick' as any]: color } : undefined}
                onClick={() => setIcon(name)}
                aria-label={name}
              >
                <Icon name={name} size={17} />
              </motion.button>
            ))}
          </motion.div>
        </div>
      </div>
    </Sheet>
  );
}
