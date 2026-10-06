// Global work-in-progress guard for preventing accidental navigation
import { translate } from "../i18n";

let _inProgress = false;

export function setWorkInProgress(v: boolean) {
  _inProgress = v;
}

export function guardNavigate(navigate: (to: string) => void, to: string) {
  if (_inProgress && !window.confirm(translate("common.leaveConfirm"))) return;
  navigate(to);
}
