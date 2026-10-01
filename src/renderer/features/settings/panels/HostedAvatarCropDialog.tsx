import { useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cropHostedAvatar,
  getHostedAvatarCrop,
  type HostedAvatarCrop,
  type HostedAvatarSource,
} from '../../../lib/hosted-account';
import { Button } from '../../../components/ui/Button';
import { ModalActions, ModalBody, ModalHeader } from '../../../components/ui/Modal';
import { HostedAccountDialog } from './HostedAccountDialog';

export function HostedAvatarCropDialog({
  source,
  onClose,
  onConfirm,
  returnFocusRef,
}: {
  source: HostedAvatarSource;
  onClose(): void;
  onConfirm(image: string): void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [crop, setCrop] = useState<HostedAvatarCrop>({ zoom: 1, offsetX: 0, offsetY: 0 });
  const [error, setError] = useState(false);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    crop: HostedAvatarCrop;
    scale: number;
  } | null>(null);
  const width = source.image.naturalWidth;
  const height = source.image.naturalHeight;
  const area = getHostedAvatarCrop(width, height, crop);
  const adjust = (next: HostedAvatarCrop) => {
    const { zoom, offsetX, offsetY } = getHostedAvatarCrop(width, height, next);
    setCrop({ zoom, offsetX, offsetY });
  };
  return (
    <HostedAccountDialog
      title={t('settings.hosted.crop_title')}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader
        title={t('settings.hosted.crop_title')}
        onClose={onClose}
        closeLabel={t('common.close')}
      />
      <ModalBody>
        <p id="hosted-avatar-crop-help" className="set-row__desc">
          {t('settings.hosted.crop_description')}
        </p>
        <div
          className="set-avatar-crop"
          tabIndex={0}
          data-dialog-autofocus
          aria-label={t('settings.hosted.crop_title')}
          aria-describedby="hosted-avatar-crop-help"
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              crop,
              scale: area.size / event.currentTarget.getBoundingClientRect().width,
            };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            adjust({
              ...start.crop,
              offsetX: start.crop.offsetX + (event.clientX - start.x) * start.scale,
              offsetY: start.crop.offsetY + (event.clientY - start.y) * start.scale,
            });
          }}
          onPointerUp={(event) => {
            if (drag.current?.id === event.pointerId) {
              drag.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const step = area.size / (event.shiftKey ? 10 : 40);
            adjust({
              ...crop,
              offsetX:
                crop.offsetX +
                (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
              offsetY:
                crop.offsetY +
                (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
            });
          }}
        >
          <img
            src={source.url}
            alt=""
            draggable={false}
            style={{
              width: `${(width / area.size) * 100}%`,
              height: `${(height / area.size) * 100}%`,
              left: `${(-area.x / area.size) * 100}%`,
              top: `${(-area.y / area.size) * 100}%`,
            }}
          />
          <span className="set-avatar-crop__mask" aria-hidden="true" />
        </div>
        <label className="set-avatar-zoom" htmlFor="hosted-avatar-zoom">
          <span>{t('settings.hosted.crop_zoom')}</span>
          <input
            id="hosted-avatar-zoom"
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={crop.zoom}
            onChange={(event) => adjust({ ...crop, zoom: Number(event.target.value) })}
          />
        </label>
        {error && (
          <p role="alert" className="set-account-notice">
            {t('settings.hosted.account_errors.INVALID_AVATAR')}
          </p>
        )}
      </ModalBody>
      <ModalActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          onClick={() => {
            try {
              onConfirm(cropHostedAvatar(source, crop));
            } catch {
              setError(true);
            }
          }}
        >
          {t('settings.hosted.crop_confirm')}
        </Button>
      </ModalActions>
    </HostedAccountDialog>
  );
}
