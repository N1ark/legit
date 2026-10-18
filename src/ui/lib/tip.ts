// purr's tooltip as an attachment, for components that pass attributes through to their element
// (`<Button {@attach tip('…')}>`), where `use:tooltip` can't go. Rather than `title`, which shows late.
import { tooltip, type TooltipSource } from 'purr';
import { fromAction } from 'svelte/attachments';

export const tip = (source: TooltipSource) => fromAction(tooltip, () => source);
