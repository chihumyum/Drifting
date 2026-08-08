import { LoginPage } from '../../../views/LoginPage';
import '../../../../styles/mobile-auth.css';

interface MobileAuthPageProps {
  initialMode: 'signin' | 'signup';
}

export function MobileAuthPage({ initialMode }: MobileAuthPageProps) {
  return <LoginPage initialMode={initialMode} presentation="mobile" />;
}
