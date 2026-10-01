import { useState } from 'react';
import { isHostedAvatar } from '../../lib/hosted-account';

/** Only render our bounded inline avatar format; offline display never fetches a URL. */
export function AccountAvatar({ image, initial }: { image?: string | null; initial: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return isHostedAvatar(image) && failed !== image ? (
    <img
      src={image}
      alt=""
      onError={() => setFailed(image)}
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 'inherit',
        objectFit: 'cover',
        display: 'block',
      }}
    />
  ) : (
    <>{initial}</>
  );
}
