/* ============================================================
 * 云服务客户端（WorkBuddy Cloud Service）
 * 应用：小流投喂墙（wbapp_vmeQs1kmHjt1zr255RV4JH）
 *
 * publicConfig 来自云服务激活结果——只有这四个字段可以进前端代码：
 *   endpoint        数据平面地址（本应用的发布域名，初始化必传）
 *   publishableKey  应用标识（本身不带任何权限，服务端校验 Origin）
 *   oauthRelayBaseUrl OAuth 中继地址（微信扫码 / WorkBuddy 账号登录用）
 *
 * 整个应用只初始化一次，所有模块共用这一个客户端。
 * 表结构与 RLS 策略由 cloud-service 技能的管理通道建好（见 README），
 * 这里只写业务代码，不执行 DDL。
 * ============================================================ */
'use strict';

const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const cloud = createWorkBuddyCloud({
  endpoint: 'https://xiaoflow-inbox.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_vmeQs1kmHjt1zr255RV4JH_gqU7ffOtJ0oyW71Ufd600ZScxzUl415t'
});

module.exports = cloud;
