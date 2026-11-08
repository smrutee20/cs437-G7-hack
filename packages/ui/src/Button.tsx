import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";
/** One action colour (blue). Red only for irreversible organiser actions behind a typed confirmation. */
export function Button({ variant = "secondary", size, block, className, type = "button", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "small"; block?: boolean }) {
  return <button type={type} className={[styles.button, styles[variant], size === "small" ? styles.small : "",
    block ? styles.block : "", className ?? ""].join(" ")} {...rest} />;
}
export const buttonClass = (variant: ButtonVariant = "secondary", size?: "small") =>
  [styles.button, styles[variant], size === "small" ? styles.small : ""].join(" ");
