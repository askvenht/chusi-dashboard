# 初司数据源（2026-11-19 实测更新）
小红书：已经用一个真实账号在它的专用窗口里实测。身份、粉丝总数和每日六项指标的来源，以及字段映射，见 README 的“当前状态”。以下 11-18 的研究记录作为历史保留；其中“当前登录账号 ID 尚无可信来源”的结论，已被实测推翻：`/api/galaxy/user/info` 由创作中心页面在登录后自行加载，返回本人 userId 和小红书号。

# 初司数据源研究（2026-11-18）
本轮只读公开文档与既有源码，没有登录、访问用户后台或请求私有接口。

## 小红书优先
官方账号开放文档：
- https://openaccount.xiaohongshu.com/docs/scope
- https://openaccount.xiaohongshu.com/docs/quick-start
- https://openaccount.xiaohongshu.com/docs/api-reference
文档当前仅开放 basic_info，粉丝/笔记读取能力列为规划中。OAuth成功响应带应用内 open_id；需要创建并审核应用、凭证、逐账号授权。不能把 OAuth open_id 直接认作创作者网页账号ID，也不能认为 OAuth登录等于创作者网页已有登录。此路线可提供应用级身份，不足以单独解决六项日指标。

已有麦田源码 followers.mjs 确认使用 creator 页面 /api/galaxy/creator/data/fans/overall_new，读取 thirty.fans_count、fans_list、rise_fans_list、leave_fans_list。只是已存在源码证据，不是公开开放API承诺；日期时区、净增/新增及当前登录账号ID仍需一次受控实测确认。已有来源仅粉丝，不能填入曝光/浏览/点赞/发布数。

可实际执行下一步：用户主动打开初司小红书专用窗口并扫码后，对这一账号做一次只读验收。先核对页面明确显示的本账号唯一标识（不以昵称/头像认定），再查看官方数据中心自然日口径和可用导出；核对至少一天数值与页面。找不到可信身份则不落库。若官方提供CSV/XLSX导出，可优先实现本地导入，要求数据含账号归属、日期、时区、指标含义，并显示导入预览待用户确认。当前未获得实际导出文件或本人身份样本，不能声称已经具备导入适配器。

## 抖音
- https://open.douyin.com/platform/resource/docs/ability/open-data/video-data-solution
- https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/video-data
- https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-video-status/
- https://open.douyin.com/platform/resource/docs/accession-guide/type-and-permission/
官方有用户授权的数据开放路线；video.data、data.external.user/item需对应申请与用户授权。视频实时点赞播放不能视作按日发生数。用户视频情况的每日新增数为累计差，删除旧作品会降低它，不能映射“当天发布作品数”。首次授权的完整数据可能需次日产生。
下一步需确认有无已批准开发者应用与数据权限。没有则需用户同意申请/提供相应凭证的安全授权流程，不在聊天收密钥。不要为了数据能力请求发布权限。

## 视频号
本轮未查到能确认覆盖普通创作者六项日指标的官方公开API，不能以第三方售卖接口代替官方。已有麦田源码在 channels.weixin.qq.com/platform/statistic/follower 读取页面文字，能解析粉丝表，但未形成可信身份识别及其他指标。
下一步只能在用户选定账号扫码后核验视频号助手的本人唯一ID、统计表及导出能力。仅粉丝可用时应显示其余指标暂无数据；不承诺全自动接入。

## 发布作品数一致口径
必须按属于该账号的作品发布时间落入北京时间自然日统计。数据源若只返回可见、公开或审核通过作品，则明确标注“可见/公开/审核通过作品数”；分页不完整、归属不明、时间缺失时不得写成完整发布数。删除过的历史作品可能无法追溯，不能以当前列表反推历史全量。每日曝光、浏览、点赞必须由日口径来源直接提供，不从作品累计差估算。
