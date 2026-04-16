import { prisma } from "../../db/prisma.js";

export const SYSTEM_SUPER_ADMIN_ROLE_NAME = "Супер-админ";

export const PERMISSION_CATALOG = [
  { code: "dashboard.view", category: "Dashboard", name: "Видеть дашборд", description: "Доступ к главному экрану KPI." },
  { code: "orders.view", category: "Orders", name: "Видеть заказы", description: "Доступ к общему реестру аренды и выкупа." },
  { code: "orders.edit", category: "Orders", name: "Редактировать сделки", description: "Изменение параметров активных сделок." },
  { code: "orders.manual_price", category: "Orders", name: "Ручное изменение цены", description: "Отдельное право на ручную смену цены или суммы сделки." },
  { code: "rentals.view", category: "Rentals", name: "Видеть аренду", description: "Открывать карточки и списки аренд." },
  { code: "rentals.create", category: "Rentals", name: "Создавать аренду", description: "Оформление новой rental-сделки." },
  { code: "rentals.post_payment", category: "Rentals", name: "Проводить оплату аренды", description: "Создание платежных операций аренды." },
  { code: "rentals.manage_deposit", category: "Rentals", name: "Управлять залогом аренды", description: "Legacy-право на прием и возврат залога по аренде." },
  { code: "rentals.receive_deposit", category: "Rentals", name: "Принимать залог аренды", description: "Отдельное право на прием залога по аренде." },
  { code: "rentals.refund_deposit", category: "Rentals", name: "Возвращать залог аренды", description: "Отдельное право на возврат залога по аренде." },
  { code: "rentals.manage_penalty", category: "Rentals", name: "Управлять автоштрафами аренды", description: "Настройка и запуск автоштрафов по аренде." },
  { code: "rentals.manual_penalty", category: "Rentals", name: "Начислять ручные штрафы аренды", description: "Отдельное право на ручное начисление штрафов по аренде." },
  { code: "rentals.pay_penalty", category: "Rentals", name: "Проводить оплату штрафа аренды", description: "Отдельное право на фиксацию реальной оплаты штрафа по аренде." },
  { code: "rentals.edit_terms", category: "Rentals", name: "Менять условия аренды", description: "Отдельное право на изменение сроков, сумм и условий аренды." },
  { code: "rentals.change_status", category: "Rentals", name: "Менять критичные статусы аренды", description: "Возврат, проблемный статус и другие критичные переходы по аренде." },
  { code: "buyouts.view", category: "Buyouts", name: "Видеть выкуп", description: "Открывать карточки и списки выкупа." },
  { code: "buyouts.create", category: "Buyouts", name: "Создавать выкуп", description: "Оформление новой buyout-сделки." },
  { code: "buyouts.post_payment", category: "Buyouts", name: "Проводить оплату выкупа", description: "Создание платежных операций выкупа." },
  { code: "buyouts.manual_penalty", category: "Buyouts", name: "Начислять ручные штрафы выкупа", description: "Отдельное право на ручное начисление штрафов по выкупу." },
  { code: "buyouts.pay_penalty", category: "Buyouts", name: "Проводить оплату штрафа выкупа", description: "Отдельное право на фиксацию реальной оплаты штрафа по выкупу." },
  { code: "buyouts.edit", category: "Buyouts", name: "Редактировать выкуп", description: "Legacy-право на изменение условий выкупной сделки." },
  { code: "buyouts.edit_terms", category: "Buyouts", name: "Менять условия выкупа", description: "Отдельное право на изменение сроков, сумм и графика выкупа." },
  { code: "buyouts.change_status", category: "Buyouts", name: "Менять критичные статусы выкупа", description: "Закрытие, problem-статус и другие критичные переходы по выкупу." },
  { code: "clients.view", category: "Clients", name: "Видеть клиентов", description: "Доступ к карточкам клиентов." },
  { code: "clients.edit", category: "Clients", name: "Редактировать клиентов", description: "Изменение карточки клиента." },
  { code: "clients.identity.view", category: "Clients", name: "Видеть паспортные данные", description: "Доступ к identity-блоку клиента." },
  { code: "clients.identity.edit", category: "Clients", name: "Редактировать паспортные данные", description: "Изменение паспортного блока." },
  { code: "fleet.view", category: "Fleet", name: "Видеть парк", description: "Просмотр техники и статусов." },
  { code: "fleet.edit", category: "Fleet", name: "Редактировать парк", description: "Изменение карточек техники." },
  { code: "tariffs.view", category: "Tariffs", name: "Видеть тарифы", description: "Просмотр тарифных групп аренды и выкупа." },
  { code: "tariffs.manage", category: "Tariffs", name: "Менять тарифы", description: "Создание, изменение тарифных групп и привязка тарифов к велосипедам." },
  { code: "repairs.view", category: "Repairs", name: "Видеть ремонты", description: "Просмотр реестра ремонтов." },
  { code: "repairs.edit", category: "Repairs", name: "Управлять ремонтами", description: "Создание и редактирование ремонтов." },
  { code: "equipment.view", category: "Equipment", name: "Видеть справочник комплектов", description: "Просмотр справочника доп. оборудования." },
  { code: "equipment.manage", category: "Equipment", name: "Менять справочник комплектов", description: "Создание, скрытие и удаление позиций доп. оборудования." },
  { code: "banks.view", category: "Banks", name: "Видеть банки", description: "Просмотр реквизитов и QR." },
  { code: "banks.edit", category: "Banks", name: "Управлять банками", description: "Legacy-право на изменение реквизитов и QR." },
  { code: "banks.manage", category: "Banks", name: "Менять банки и реквизиты", description: "Отдельное право на изменение банков, реквизитов и платежных инструкций." },
  { code: "finance.view", category: "Finance", name: "Видеть финансы", description: "Доступ к реестру операций." },
  { code: "finance.manage_articles", category: "Finance", name: "Управлять статьями финансов", description: "Создание, переименование и архивирование статей прихода и расхода." },
  { code: "finance.post_manual_income", category: "Finance", name: "Проводить ручной приход", description: "Создание ручных приходных операций в реестре денег." },
  { code: "finance.post_manual_expense", category: "Finance", name: "Проводить ручной расход", description: "Создание ручных расходных операций в реестре денег." },
  { code: "finance.reverse_manual", category: "Finance", name: "Сторнировать ручные операции", description: "Создание compensating reversal для ручных денежных операций." },
  { code: "finance.reverse_penalty", category: "Finance", name: "Сторнировать оплату штрафов", description: "Создание reversal для оплаты штрафа с возвратом штрафа в активное состояние." },
  { code: "finance.reconcile", category: "Finance", name: "Сверять финансовые операции", description: "Помечать денежные операции как сверенные и снимать сверку." },
  { code: "finance.post", category: "Finance", name: "Проводить операции", description: "Проведение оплат и поступлений." },
  { code: "finance.refund", category: "Finance", name: "Делать возвраты", description: "Возврат залога и средств." },
  { code: "finance.export", category: "Finance", name: "Экспортировать финансы", description: "Экспорт финансового реестра." },
  { code: "documents.view", category: "Documents", name: "Видеть документы", description: "Просмотр списка документов и шаблонов." },
  { code: "documents.generate", category: "Documents", name: "Генерировать документы", description: "Генерация договоров и актов." },
  { code: "documents.manage_templates", category: "Documents", name: "Управлять шаблонами", description: "Загрузка и настройка шаблонов." },
  { code: "statistics.view", category: "Statistics", name: "Видеть статистику", description: "Доступ к KPI и аналитике." },
  { code: "notifications.view", category: "Notifications", name: "Видеть уведомления", description: "Просмотр сценариев и истории уведомлений." },
  { code: "notifications.edit", category: "Notifications", name: "Управлять уведомлениями", description: "Редактирование сценариев уведомлений." },
  { code: "users.view", category: "Users", name: "Видеть пользователей и роли", description: "Просмотр сотрудников, ролей и матрицы прав." },
  { code: "users.manage_users", category: "Users", name: "Управлять сотрудниками", description: "Создание сотрудников и изменение их базовой карточки." },
  { code: "users.assign_roles", category: "Users", name: "Назначать роли пользователям", description: "Привязка и снятие ролей у сотрудников tenant-компании." },
  { code: "users.manage_roles", category: "Users", name: "Управлять ролями", description: "Создание и редактирование ролей и прав." },
  { code: "audit.view", category: "Audit", name: "Видеть аудит", description: "Просмотр журнала действий." },
  { code: "settings.view", category: "Settings", name: "Видеть настройки", description: "Просмотр настроек и интеграций." },
  { code: "settings.edit", category: "Settings", name: "Редактировать настройки", description: "Изменение настроек компании." },
  { code: "gps.view", category: "GPS", name: "Видеть GPS workspace", description: "Просмотр статуса GPS-подключения и сохраненных трекеров." },
  { code: "gps.manage_settings", category: "GPS", name: "Менять настройки GPS", description: "Настройка API-подключения GPS-провайдера." },
  { code: "gps.manage_binding", category: "GPS", name: "Привязывать GPS-трекеры", description: "Изменение привязки трекеров к велосипедам." },
  { code: "imports.view", category: "Imports", name: "Видеть импорт и legacy preview", description: "Просмотр import runs, row-level issues и legacy preview." },
  { code: "imports.run", category: "Imports", name: "Запускать импорт", description: "Dry-run и commit-импорт из legacy и внешних систем." },
  { code: "saas.view", category: "SaaS", name: "Видеть SaaS-админку", description: "Доступ к tenant-админке SaaS owner." },
  { code: "saas.impersonate", category: "SaaS", name: "Support impersonation", description: "Безопасный support-вход в tenant." }
] as const;

export async function ensurePermissionCatalog() {
  await prisma.permission.createMany({
    data: PERMISSION_CATALOG.map((permission) => ({
      code: permission.code,
      category: permission.category,
      name: permission.name,
      description: permission.description
    })),
    skipDuplicates: true
  });
}

export async function ensureSystemRoles(tenantId: string) {
  await ensurePermissionCatalog();

  const permissions = await prisma.permission.findMany({
    select: {
      id: true
    }
  });

  await prisma.$transaction(async (tx) => {
    const role = await tx.role.upsert({
      where: {
        tenantId_name: {
          tenantId,
          name: SYSTEM_SUPER_ADMIN_ROLE_NAME
        }
      },
      create: {
        tenantId,
        name: SYSTEM_SUPER_ADMIN_ROLE_NAME,
        description: "Системный пресет с полным доступом ко всем разделам и действиям CRM.",
        isSystem: true
      },
      update: {
        description: "Системный пресет с полным доступом ко всем разделам и действиям CRM.",
        isSystem: true
      },
      select: {
        id: true
      }
    });

    for (const permission of permissions) {
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id
          }
        },
        create: {
          roleId: role.id,
          permissionId: permission.id,
          branchScoped: false
        },
        update: {
          branchScoped: false
        }
      });
    }
  });
}

export async function loadPermissionsByCodes(codes: string[]) {
  if (codes.length === 0) {
    return [];
  }

  return prisma.permission.findMany({
    where: {
      code: {
        in: codes
      }
    },
    select: {
      id: true,
      code: true
    }
  });
}

export async function assignSystemRoleToUser(params: {
  tenantId: string;
  userId: string;
  roleName?: string;
}) {
  const role = await prisma.role.findUnique({
    where: {
      tenantId_name: {
        tenantId: params.tenantId,
        name: params.roleName ?? SYSTEM_SUPER_ADMIN_ROLE_NAME
      }
    },
    select: {
      id: true
    }
  });

  if (!role) {
    throw new Error(`System role '${params.roleName ?? SYSTEM_SUPER_ADMIN_ROLE_NAME}' was not found`);
  }

  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: params.userId,
        roleId: role.id
      }
    },
    create: {
      userId: params.userId,
      roleId: role.id
    },
    update: {}
  });
}
