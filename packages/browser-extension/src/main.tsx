import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { createHashRouter, RouterProvider } from "react-router-dom";
import OptionsPage from "./OptionsPage.tsx";
import NotConfiguredPage from "./NotConfiguredPage.tsx";

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
  },
  {
    path: "/notconfigured",
    element: <NotConfiguredPage />,
  },
  {
    path: "/options",
    element: <OptionsPage />,
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="w-96 p-4">
      <RouterProvider router={router} />
    </div>
  </React.StrictMode>,
);