import * as React from "react"
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

const AlertDialog = AlertDialogPrimitive.Root

const AlertDialogTrigger = AlertDialogPrimitive.Trigger

const AlertDialogPortal = AlertDialogPrimitive.Portal

const AlertDialogOverlay = React.forwardRef(
  /** @param {React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>} props @param {React.ForwardedRef<React.ElementRef<typeof AlertDialogPrimitive.Overlay>>} ref */
  ({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref} />
))
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName

const AlertDialogContent = React.forwardRef(
  /** @param {React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>} props @param {React.ForwardedRef<React.ElementRef<typeof AlertDialogPrimitive.Content>>} ref */
  ({ className, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props} />
  </AlertDialogPortal>
))
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName

/** @param {React.HTMLAttributes<HTMLDivElement>} props */
const AlertDialogHeader = ({
  className,
  ...props
}) => (
  <div
    className={cn("flex flex-col space-y-2 text-center sm:text-left", className)}
    {...props} />
)
AlertDialogHeader.displayName = "AlertDialogHeader"

/** @param {React.HTMLAttributes<HTMLDivElement>} props */
const AlertDialogFooter = ({
  className,
  ...props
}) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props} />
)
AlertDialogFooter.displayName = "AlertDialogFooter"

const AlertDialogTitle = React.forwardRef(
  /** @param {React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>} props @param {React.ForwardedRef<React.ElementRef<typeof AlertDialogPrimitive.Title>>} ref */
  ({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />
))
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName

const AlertDialogDescription = React.forwardRef(
  /** @param {React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>} props @param {React.ForwardedRef<React.ElementRef<typeof AlertDialogPrimitive.Description>>} ref */
  ({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props} />
))
AlertDialogDescription.displayName =
  AlertDialogPrimitive.Description.displayName

// Botão de confirmar. `destructive` (pedido do usuário, 23/11, "opção B"): ações que apagam/encerram/substituem algo ficam em VERMELHO SUAVE (fundo translúcido + contorno),
// no tom de perda do painel (#e06a5b) — o mesmo vermelho do resto da tela, sem o vermelho cheio que destoa do visual plano. Sem a prop, é o botão de sempre.
const DESTRUCTIVE_CLASS = "bg-[#e06a5b]/15 text-[#e06a5b] border border-[#e06a5b]/45 hover:bg-[#e06a5b]/25";
const AlertDialogAction = React.forwardRef(
  /** @param {React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> & { destructive?: boolean }} props @param {React.ForwardedRef<React.ElementRef<typeof AlertDialogPrimitive.Action>>} ref */
  ({ className, destructive = false, ...props }, ref) => (
  <AlertDialogPrimitive.Action ref={ref} className={cn(buttonVariants(), destructive && DESTRUCTIVE_CLASS, className)} {...props} />
))
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName

const AlertDialogCancel = React.forwardRef(
  /** @param {React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>} props @param {React.ForwardedRef<React.ElementRef<typeof AlertDialogPrimitive.Cancel>>} ref */
  ({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(buttonVariants({ variant: "outline" }), "mt-2 sm:mt-0", className)}
    {...props} />
))
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
