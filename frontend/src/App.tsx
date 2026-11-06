import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useMatch } from "react-router";

import { DeviceListPage } from "./components/DeviceListPage.js";
import { LoginPage } from "./components/LoginPage.js";
import { OwnerGate } from "./components/OwnerGate.js";
import { RemoteControlPage } from "./components/RemoteControlPage.js";
import { ShareGuestPage } from "./components/ShareGuestPage.js";
import { Toast } from "./components/Toast.js";
import { useRemoteControlController } from "./controllers/useRemoteControlController.js";
import "./styles/index.css";

export default function App() {
  return (
    <BrowserRouter>
      <RootRoutes />
    </BrowserRouter>
  );
}

function RootRoutes() {
  const shareMatch = useMatch("/share/:shareId");
  // 访客页不加载主控制器：访客没有 UU 登录态，也不应该触发任何 /api/remote 请求。
  // 它同样不进 OwnerGate——访客不该看到主人的口令输入框。
  if (shareMatch?.params.shareId) {
    return <ShareGuestPage shareId={shareMatch.params.shareId} />;
  }
  return (
    <OwnerGate>
      <AppRoutes />
    </OwnerGate>
  );
}

function AppRoutes() {
  const controller = useRemoteControlController();
  const loginPage = <LoginPage {...controller.loginPageProps} />;

  let content: ReactNode;
  if (controller.authLoading) {
    content = (
      <main className="product-shell auth-product-shell" aria-label="正在恢复登录态">
        <p className="empty-text">正在恢复登录态...</p>
      </main>
    );
  } else if (!controller.loggedIn) {
    content = (
      <Routes>
        <Route path="/login" element={loginPage} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  } else {
    const deviceListPage = <DeviceListPage {...controller.deviceListPageProps} />;
    const controlPage = <RemoteControlPage {...controller.controlPageProps} />;
    content = (
      <Routes>
        <Route path="/" element={<Navigate to="/devices" replace />} />
        <Route path="/login" element={<Navigate to="/devices" replace />} />
        <Route path="/devices" element={deviceListPage} />
        <Route path="/devices/:deviceId/control" element={controlPage} />
        <Route path="*" element={<Navigate to="/devices" replace />} />
      </Routes>
    );
  }

  return (
    <>
      {content}
      <Toast toast={controller.toast} onDismiss={controller.onDismissToast} />
    </>
  );
}
