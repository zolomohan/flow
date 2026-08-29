import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { spring } from '../lib/motion';

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            className={`toast toast-${toast.tone}`}
            initial={{ opacity: 0, y: 20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={spring}
          >
            <Icon name={toast.tone === 'ok' ? 'check' : 'alert-circle'} size={15} />
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                onClick={() => {
                  toast.undo?.();
                  dismissToast(toast.id);
                }}
              >
                Undo
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
