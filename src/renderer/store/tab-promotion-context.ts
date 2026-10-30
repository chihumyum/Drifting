import { createContext } from 'react';

/**
 * An editor mounted outside the workspace's tabs (the element overview's
 * floating island) edits its entity without promoting whichever tab happens
 * to be current under the Super View. Inside this context
 * `usePromoteCurrentTab` does nothing.
 */
export const TabPromotionSuppressedContext = createContext(false);
