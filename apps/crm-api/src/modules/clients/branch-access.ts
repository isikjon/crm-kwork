import { Prisma } from "@prisma/client";

export const branchLinkedRentalStatuses = [
  "NEW",
  "ACTIVE",
  "OVERDUE",
  "HOLD",
  "RETURN_PREP"
] as const;

export const branchLinkedBuyoutStatuses = [
  "NEW",
  "ACTIVE",
  "OVERDUE",
  "HOLD"
] as const;

export function buildBranchLinkedClientAccessWhere(
  tenantId: string,
  branchId?: string | null
): Prisma.ClientWhereInput | null {
  if (!branchId) {
    return null;
  }

  return {
    OR: [
      {
        rentals: {
          some: {
            tenantId,
            branchId,
            status: {
              in: [...branchLinkedRentalStatuses]
            }
          }
        }
      },
      {
        buyouts: {
          some: {
            tenantId,
            branchId,
            status: {
              in: [...branchLinkedBuyoutStatuses]
            }
          }
        }
      }
    ]
  };
}

export function applyClientAccessWhere(
  baseWhere: Prisma.ClientWhereInput,
  accessWhere?: Prisma.ClientWhereInput | null
): Prisma.ClientWhereInput {
  if (!accessWhere) {
    return baseWhere;
  }

  return {
    AND: [baseWhere, accessWhere]
  };
}
