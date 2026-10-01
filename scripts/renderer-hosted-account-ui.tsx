import { createRoot } from 'react-dom/client';
import { HostedAccountDetails } from '../src/renderer/features/settings/panels/HostedAccountDetails';
import { AccountAvatar } from '../src/renderer/components/ui/AccountAvatar';
import {
  normalizeHostedProfileUpdate,
  validateHostedPassword,
} from '../src/renderer/lib/hosted-account';
import { useAuthStore } from '../src/renderer/store/auth';
import { i18next } from '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/settings.css';

const observations = { profileWrites: 0, passwordWrites: 0, failNext: false };
useAuthStore.setState({
  hostedUser: {
    id: 'synthetic-account',
    name: '合成作者',
    email: 'synthetic@example.test',
    emailVerified: true,
  },
  hostedStatus: 'connected',
  updateHostedProfile: async (input) => {
    observations.profileWrites++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (observations.failNext) {
      observations.failNext = false;
      throw new Error('NETWORK_ERROR');
    }
    const update = normalizeHostedProfileUpdate(input);
    useAuthStore.setState((state) => ({ hostedUser: { ...state.hostedUser!, ...update } }));
  },
  changeHostedPassword: async (current, next, confirmation) => {
    validateHostedPassword(current, next, confirmation);
    observations.passwordWrites++;
  },
});
export function Fixture() {
  const user = useAuthStore((state) => state.hostedUser)!;
  const status = useAuthStore((state) => state.hostedStatus);
  return (
    <main className="set-panel" style={{ maxWidth: 820, margin: '0 auto', padding: '28px 40px' }}>
      <h1 className="set-panel__title">账号与托管同步</h1>
      <div className="set-rail__who">
        <span className="set-account-avatar">
          <AccountAvatar image={user.image} initial={user.name[0]} />
        </span>
        <span id="saved-name">{user.name}</span>
      </div>
      <HostedAccountDetails user={user} disabled={status !== 'connected'} />
    </main>
  );
}
Object.assign(window, {
  __HOSTED_ACCOUNT_UI__: {
    observations,
    offline: () => useAuthStore.setState({ hostedStatus: 'offline' }),
  },
});
void i18next
  .changeLanguage('zh-CN')
  .then(() => createRoot(document.getElementById('root')!).render(<Fixture />));
