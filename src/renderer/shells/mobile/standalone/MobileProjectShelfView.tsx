import { ProjectPickerView } from '../../../views/ProjectPickerView';
import { PreAlphaFirstRunGate } from '../../../components/modals/PreAlphaOnboardingDialog';
import '../../../../styles/mobile-project-shelf.css';

/**
 * The phone's shelf is the desktop's: the same first run rising out of the
 * sea of characters, the same writing year and the same book cards, laid out
 * in one column for a phone (mobile-project-shelf.css).
 */
export function MobileProjectShelfView() {
  return (
    <PreAlphaFirstRunGate>
      <ProjectPickerView />
    </PreAlphaFirstRunGate>
  );
}
