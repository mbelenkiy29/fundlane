"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAGE_KEYS = exports.API_KEY_SCOPES = exports.MEMBERSHIP_STATUSES = exports.ROLES = void 0;
exports.ROLES = ["rep", "manager", "admin", "super_admin"];
exports.MEMBERSHIP_STATUSES = ["pending", "active", "deactivated"];
exports.API_KEY_SCOPES = [
    "deals:read",
    "deals:write",
    "deals:export",
    "intake:write",
    "workspace:read",
];
exports.PAGE_KEYS = [
    "dashboard",
    "deals",
    "users",
    "reports",
    "payments",
    "workspace",
    "integrations",
];
