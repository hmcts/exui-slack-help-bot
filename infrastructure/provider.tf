terraform {
  required_version = "~> 1.3.0"
  backend "azurerm" {}
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "3.47.0"
    }
  }
}

provider "azurerm" {
  features {}
}
